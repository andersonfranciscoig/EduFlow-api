import { KINDS } from "../../notifications/domain/catalog";
import type { EmailSection, StaffNotify } from "../../notifications/infrastructure/notifier";
import { DIGEST_DELAY_MINUTES, DIGEST_WINDOW_HOURS, type DigestContent, familyDigest, staffDigest } from "../domain/digest";
import { localNow } from "../domain/presence";
import type { AttendanceRules } from "../domain/settings";
import type { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import type { PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import type { DueFamily, DueStaff, PrismaDigestsRepository } from "../infrastructure/prisma-digests";
import type { AttendanceSettings } from "./AttendanceSettings";

export const DIGEST_JOB = "attendance.digest";
/** Quantos por volta (o resto fica para a volta seguinte, um minuto depois: não prende os outros colégios). */
const BATCH = 60;

export interface DigestStats {
  now: string;
  staff: number;
  family: number;
  emails: number;
  errors: number;
}
/** Email da família (a implementação é o Notifier, já ligado ao colégio). */
export type FamilyMail = (m: { to: { email: string; name: string }; title: string; body: string; link: string; sections: EmailSection[] }) => Promise<void>;

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dayBefore = (day: string) => new Date(new Date(`${day}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
const emailSections = (c: DigestContent): EmailSection[] => c.sections.map((s) => ({ title: s.title, lines: s.items.map((i) => i.text) }));

/**
 * RESUMOS DIÁRIOS (tarefa automática, por colégio). Corre em cada volta: envia a cada pessoa, uma vez
 * por dia, 1 hora depois da sua última aula prevista. Idempotente (um por pessoa e dia, na BD), recupera
 * o que ficou devido se esteve parada (até 18 h) e o erro de uma pessoa não para as outras.
 * Só regista uma execução quando há o que fazer (ou quando é pedida à mão).
 */
export class DigestJob {
  constructor(private readonly settings: AttendanceSettings) {}

  async run(
    repo: PrismaDigestsRepository,
    runs: PrismaDeadlineRepository,
    settingsRepo: PrismaAttendanceSettingsRepository,
    notify: StaffNotify,
    mail: FamilyMail,
    trigger: "SCHEDULER" | "MANUAL",
    now: Date,
  ) {
    await settingsRepo.ensure(now);
    const rules = await this.settings.rules(settingsRepo);
    const nowLocal = localNow(rules.timeZone, now);
    const today = nowLocal.slice(0, 10);
    const days = [dayBefore(today), today];
    const since = rules.trackingSince ?? today;
    const types = await repo.types(["DAILY_DIGEST", "FAMILY_DAILY_DIGEST"]);
    const on = (k: "DAILY_DIGEST" | "FAMILY_DAILY_DIGEST") => types.get(k)?.enabled ?? KINDS[k].defaultEnabled;
    const familyEmail = types.get("FAMILY_DAILY_DIGEST")?.email ?? KINDS.FAMILY_DAILY_DIGEST.defaultEmail;

    const [staff, family, pendingMail] = await Promise.all([
      on("DAILY_DIGEST") ? repo.dueStaff(days, since, nowLocal, DIGEST_DELAY_MINUTES, DIGEST_WINDOW_HOURS, BATCH) : [],
      on("FAMILY_DAILY_DIGEST") ? repo.dueFamily(days, since, nowLocal, DIGEST_DELAY_MINUTES, DIGEST_WINDOW_HOURS, BATCH) : [],
      repo.pendingEmails(now),
    ]);
    const stats: DigestStats = { now: nowLocal, staff: 0, family: 0, emails: 0, errors: 0 };
    if (trigger === "SCHEDULER" && !staff.length && !family.length && !pendingMail) return { skipped: false as const, stats };

    const runId = await runs.begin(DIGEST_JOB, trigger, now);
    if (!runId) return { skipped: true as const, reason: "Já há um envio de resumos a decorrer." };
    let lastError: string | null = null;
    const guard = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch (e) {
        stats.errors++;
        lastError = String((e as Error).message).slice(0, 500);
      }
    };
    try {
      for (const d of staff) await guard(async () => void (stats.staff += await this.sendStaff(repo, rules, notify, d, now)));
      for (const d of family) await guard(async () => void (stats.family += await this.sendFamily(repo, rules, d, familyEmail, now)));
      // os emails da família saem depois de gravados (o que falhar volta a tentar-se na volta seguinte)
      for (const m of await repo.claimEmails(now, BATCH)) await guard(async () => void (stats.emails += await this.sendMail(repo, mail, m, now)));
      await runs.finish(runId, stats.errors ? "FAILED" : "DONE", { ...stats }, lastError, new Date());
      return { skipped: false as const, stats };
    } catch (e) {
      await runs.finish(runId, "FAILED", { ...stats }, String((e as Error).message).slice(0, 500), new Date()).catch(() => undefined);
      throw e;
    }
  }

  private async sendStaff(repo: PrismaDigestsRepository, rules: AttendanceRules, notify: StaffNotify, d: DueStaff, now: Date) {
    const [lessons, groups, notices] = await Promise.all([repo.teacherLessons(d.employeeId, d.day), repo.coordinatedDays(d.employeeId, d.day, rules.timeZone), repo.staffNotices(d.userId, d.day, rules.timeZone)]);
    const content = staffDigest({ lessons, groups, notices, consecutiveLimit: rules.consecutiveLimit });
    // primeiro o aviso (a chave impede repeti-lo), depois o resumo: se parar a meio, a volta seguinte completa
    await notify.notify({
      kind: "DAILY_DIGEST",
      userIds: [d.userId],
      title: `Resumo do dia ${dmy(d.day)}`,
      body: content.headline,
      link: `/resumos?dia=${d.day}`,
      dedupeKey: `digest:${d.day}`,
      sections: emailSections(content),
    });
    await repo.saveStaff(d, content, now);
    return 1;
  }

  private async sendFamily(repo: PrismaDigestsRepository, rules: AttendanceRules, d: DueFamily, byEmail: boolean, now: Date) {
    const [students, notices, prefs] = await Promise.all([repo.studentDays(d.studentIds, d.day), repo.familyNotices(d.accountId, d.day, rules.timeZone), byEmail ? repo.familyPreferences(d.accountId) : new Map<string, boolean>()]);
    const content = familyDigest({ students, notices });
    const title = `Resumo do dia ${dmy(d.day)}`;
    const wants = prefs.get("FAMILY_DAILY_DIGEST") !== false;
    const made = await repo.saveFamily(d, content, byEmail && wants, { kind: "FAMILY_DAILY_DIGEST", title, body: content.headline, link: `/familia/resumos?dia=${d.day}` }, now);
    if (made && byEmail && !wants) await repo.logFamilyEmail({ accountId: d.accountId, fullName: d.fullName, kind: "FAMILY_DAILY_DIGEST", title, destination: d.email, status: "SKIPPED", error: "Recusado nas preferências", now });
    return made ? 1 : 0;
  }

  private async sendMail(repo: PrismaDigestsRepository, mail: FamilyMail, m: Awaited<ReturnType<PrismaDigestsRepository["claimEmails"]>>[number], now: Date) {
    const title = `Resumo do dia ${dmy(m.day)}`;
    const log = (status: "SENT" | "FAILED", error: string | null) => repo.logFamilyEmail({ accountId: m.account_id, fullName: m.full_name, kind: "FAMILY_DAILY_DIGEST", title, destination: m.email, status, error, now });
    try {
      await mail({ to: { email: m.email, name: m.full_name }, title, body: m.headline, link: `/familia/resumos?dia=${m.day}`, sections: emailSections(m.content) });
    } catch (e) {
      const error = String((e as Error).message).slice(0, 300);
      await repo.emailResult(m.id, m.attempts >= 3 ? "FAILED" : "PENDING");
      await log("FAILED", error);
      throw e;
    }
    await repo.emailResult(m.id, "SENT");
    await log("SENT", null);
    return 1;
  }
}
