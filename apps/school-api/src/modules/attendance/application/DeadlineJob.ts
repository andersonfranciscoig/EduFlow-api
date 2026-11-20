import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import { localNow } from "../domain/presence";
import type { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import type { NewPending, PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import type { AttendanceSettings } from "./AttendanceSettings";

export const DEADLINE_JOB = "attendance.deadline";
/** Recuperação de falhas: cada execução revê sempre os últimos 14 dias (o que já foi tratado não se repete). */
const LOOKBACK_DAYS = 14;
const AUTO_NOTE = "Presenças não submetidas no prazo (política do colégio).";
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const minusDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
const byTeacher = <T extends { teacherId: string }>(list: T[]) => {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(x.teacherId, [...(m.get(x.teacherId) ?? []), x]);
  return m;
};
const line = (p: NewPending) => `${dmy(p.day)} ${p.startsAt} · ${p.subjectName} (${p.groupName})`;

export interface DeadlineStats {
  from: string;
  now: string;
  pendings: number;
  autoOccurrences: number;
  presentDays: number;
}

/**
 * O PRAZO DAS PRESENÇAS (tarefa automática, por colégio):
 *  1. aulas do horário cujo prazo (fim + regras) passou sem presenças → pendência (o RH é avisado,
 *     agrupado numa notificação; o professor também, com a lista das suas);
 *  2. gestão automática: modelo por aula → falta automática a cada aula pendente; modelo por dia →
 *     dia fechado sem nenhuma aula submetida = falta do dia; com alguma submetida = presente;
 *  3. tudo idempotente: correr de novo (ou em duas instâncias) não repete nada; uma ocorrência
 *     anulada pelo RH nunca volta a ser criada.
 * Conta a partir da data de início do controlo (regras) e revê os últimos 14 dias.
 */
export class DeadlineJob {
  constructor(private readonly settings: AttendanceSettings) {}

  async run(repo: PrismaDeadlineRepository, settingsRepo: PrismaAttendanceSettingsRepository, notify: StaffNotify, trigger: "SCHEDULER" | "MANUAL", now: Date) {
    const runId = await repo.begin(DEADLINE_JOB, trigger, now);
    if (!runId) return { skipped: true as const, reason: "Já há uma verificação a decorrer." };
    try {
      await settingsRepo.ensure(now);
      const rules = await this.settings.rules(settingsRepo);
      const nowLocal = localNow(rules.timeZone, now);
      const today = nowLocal.slice(0, 10);
      const since = rules.trackingSince ?? today;
      const lookback = minusDays(today, LOOKBACK_DAYS);
      const from = since > lookback ? since : lookback;
      const stats: DeadlineStats = { from, now: nowLocal, pendings: 0, autoOccurrences: 0, presentDays: 0 };
      if (from > today) {
        await repo.finish(runId, "DONE", { ...stats }, null, new Date());
        return { skipped: false as const, stats };
      }

      // 1. pendências novas
      const pendings = await repo.createPendings(from, today, nowLocal, rules.deadlineMinutes, now);
      stats.pendings = pendings.length;
      const autoByTeacher = new Map<string, string[]>();
      const addAuto = (t: string, text: string) => autoByTeacher.set(t, [...(autoByTeacher.get(t) ?? []), text]);

      // 2a. modelo por aula, gestão automática: falta a cada aula pendente (nova)
      if (rules.missingProcedure === "AUTOMATIC" && rules.teacherModel === "PER_LESSON") {
        for (const p of pendings) {
          const occ = await repo.autoLessonOccurrence(p, AUTO_NOTE, now);
          if (!occ) continue;
          stats.autoOccurrences++;
          await repo.record("TEACHER_OCCURRENCE_CREATED", occ, { after: { kind: "FALTA", minutesLate: null, status: "REGISTADA", source: "AUTOMATIC" }, reason: AUTO_NOTE }, now);
          addAuto(p.teacherId, line(p));
        }
      }

      // 2b. modelo por dia: dias fechados — presente (submeteu alguma) ou, na gestão automática, falta do dia
      if (rules.teacherModel === "PER_DAY") {
        for (const d of await repo.teacherDaysToEvaluate(from, today, nowLocal, rules.deadlineMinutes)) {
          if (d.submitted) {
            await repo.dailyPresent(d.teacher_id, d.day, now);
            stats.presentDays++;
          } else if (rules.missingProcedure === "AUTOMATIC") {
            const occ = await repo.autoDayOccurrence(d.teacher_id, d.day, AUTO_NOTE, now);
            if (!occ) continue;
            stats.autoOccurrences++;
            await repo.record("TEACHER_OCCURRENCE_CREATED", occ, { after: { kind: "FALTA", minutesLate: null, status: "REGISTADA", source: "AUTOMATIC" }, reason: AUTO_NOTE }, now);
            addAuto(d.teacher_id, `${dmy(d.day)} · o dia (${d.lessons} aula${d.lessons === 1 ? "" : "s"} sem presenças)`);
          }
        }
      }

      // 3. avisos agrupados (uma notificação por destinatário e por execução)
      if (pendings.length) {
        const lines = pendings.slice(0, 12).map((p) => `${line(p)} — ${p.teacherName}`);
        const more = pendings.length > 12 ? ` (+${pendings.length - 12})` : "";
        await notify.notify({
          kind: "ATTENDANCE_PENDING",
          userIds: await repo.hrUserIds(),
          title: `${pendings.length} aula${pendings.length === 1 ? "" : "s"} sem presenças no prazo`,
          body: `${lines.join("; ")}${more}.${stats.autoOccurrences ? ` Gestão automática: ${stats.autoOccurrences} falta${stats.autoOccurrences === 1 ? "" : "s"} registada${stats.autoOccurrences === 1 ? "" : "s"} (pode rever e corrigir).` : " Gestão manual: analise e decida."}`,
          link: "/rh/aulas-pendentes",
          dedupeKey: `pending:${pendings[0].id}`,
        });
        for (const [teacherId, list] of byTeacher(pendings)) {
          await notify.notify({
            kind: "ATTENDANCE_MISSING",
            employeeIds: [teacherId],
            title: `Presenças por registar: ${list.length} aula${list.length === 1 ? "" : "s"}`,
            body: `${list.map(line).join("; ")}. O prazo passou: ainda pode registá-las (ficam fora do prazo).`,
            link: `/presencas?data=${list[0].day}`,
            dedupeKey: `missing:${list[0].id}`,
          });
        }
      }
      for (const [teacherId, list] of autoByTeacher) {
        await notify.notify({
          kind: "TEACHER_OCCURRENCE",
          employeeIds: [teacherId],
          title: `Falta${list.length === 1 ? "" : "s"} registada${list.length === 1 ? "" : "s"} automaticamente`,
          body: `${list.join("; ")}. ${AUTO_NOTE} Se deu a aula, fale com o RH para corrigir.`,
          link: "/presencas",
        });
      }

      await repo.finish(runId, "DONE", { ...stats }, null, new Date());
      return { skipped: false as const, stats };
    } catch (e) {
      await repo.finish(runId, "FAILED", null, String((e as Error).message).slice(0, 500), new Date()).catch(() => undefined);
      throw e;
    }
  }
}
