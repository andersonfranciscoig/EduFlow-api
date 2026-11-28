import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../../config/env";
import { TenantConnections } from "../../../tenancy/tenant-connections";
import { TenantDirectory } from "../../../tenancy/tenant-directory";
import { Announcements } from "../../communication/application/Announcements";
import { PrismaAnnouncementsRepository } from "../../communication/infrastructure/prisma-announcements";
import { ExamNotices } from "../../exams/application/ExamNotices";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import { PrismaExamsRepository } from "../../exams/infrastructure/prisma-exams";
import { Reminders } from "../../finance/application/Reminders";
import { PrismaRemindersRepository } from "../../finance/infrastructure/prisma-reminders";
import { Payments } from "../../finance/application/Payments";
import { PrismaPaymentsRepository } from "../../finance/infrastructure/prisma-payments";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { DeadlineJob } from "../application/DeadlineJob";
import { DigestJob } from "../application/DigestJob";
import { AttendanceSettings } from "../application/AttendanceSettings";
import { localNow } from "../domain/presence";
import { PrismaAttendanceSettingsRepository } from "./prisma-attendance-settings";
import { PrismaDeadlineRepository } from "./prisma-deadline";
import { PrismaDigestsRepository } from "./prisma-digests";

/**
 * O ciclo das tarefas automáticas: de JOBS_INTERVAL_MS em JOBS_INTERVAL_MS percorre os colégios
 * ativos e corre, em cada um, o prazo das presenças e depois os resumos diários (um colégio de cada
 * vez; a falha de um, ou de uma tarefa, não para as outras).
 * Nunca se sobrepõe a si próprio; entre instâncias, a BD de cada colégio decide quem corre
 * (registo em job_runs com bloqueio). Desligado com JOBS_ENABLED=false (ex.: testes).
 */
@Injectable()
export class AttendanceScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("AttendanceScheduler");
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** colégios cuja BD ainda não tem as tabelas da assiduidade (já avisados) */
  private readonly missing = new Set<string>();
  private readonly missingDigests = new Set<string>();
  /** dia em que as cobranças de cada colégio já foram postas em dia (é idempotente: repetir não faz mal) */
  private readonly chargesDay = new Map<string, string>();
  private readonly remindersDay = new Map<string, string>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnections,
    private readonly job: DeadlineJob,
    private readonly digests: DigestJob,
    private readonly notifier: Notifier,
    private readonly examNotices: ExamNotices,
    private readonly settings: AttendanceSettings,
    private readonly payments: Payments,
    private readonly reminders: Reminders,
    private readonly announcements: Announcements,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get("JOBS_ENABLED", { infer: true }) !== "true") {
      this.logger.log("tarefas automáticas desligadas (JOBS_ENABLED=false)");
      return;
    }
    const every = this.config.get("JOBS_INTERVAL_MS", { infer: true });
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
    this.logger.log(`tarefas automáticas a cada ${Math.round(every / 1000)} s`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Uma volta por todos os colégios. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const slugs = await this.directory.activeSlugs();
      for (const slug of slugs) {
        try {
          const entry = await this.directory.findBySlug(slug);
          if (!entry) continue;
          const db = this.connections.get(entry);
          // BD ainda sem as migrações da assiduidade ou das provas? não tenta (sem erros no log a cada minuto)
          const [ready] = await db.$queryRaw<{ ok: boolean }[]>`SELECT (to_regclass('job_runs') IS NOT NULL AND to_regclass('staff_notifications') IS NOT NULL AND to_regclass('exam_notices') IS NOT NULL) AS ok`;
          if (!ready?.ok) {
            if (!this.missing.has(slug)) this.logger.warn(`${slug}: faltam migrações da assiduidade na BD do colégio — reinicie o provisioner (aplica-as ao arrancar). Até lá, o prazo das presenças não corre aqui.`);
            this.missing.add(slug);
            continue;
          }
          await this.job.run(new PrismaDeadlineRepository(db), new PrismaAttendanceSettingsRepository(db), this.notifier.for(db, { slug: entry.slug, name: entry.schoolName }), "SCHEDULER", new Date());
          if (this.missing.delete(slug)) this.logger.log(`${slug}: migrações aplicadas, o prazo das presenças já corre`);
        } catch (e) {
          // uma BD em baixo (ou sem as tabelas desta fase) não para os outros colégios
          const code = (e as { meta?: { code?: string } }).meta?.code;
          if (code === "42P01" || code === "42703") {
            // BD do colégio ainda sem as migrações desta fase: avisa UMA vez (não a cada minuto)
            if (!this.missing.has(slug)) this.logger.warn(`${slug}: faltam migrações da assiduidade na BD do colégio — reinicie o provisioner (aplica-as ao arrancar). Até lá, o prazo das presenças não corre aqui.`);
            this.missing.add(slug);
            continue;
          }
          this.logger.warn(`prazo das presenças falhou em ${slug}: ${(e as Error).message}`);
        }
        await this.runDigests(slug);
        await this.runExamNotices(slug);
        await this.runPayments(slug);
        await this.runAnnouncements(slug);
      }
    } catch (e) {
      this.logger.warn(`não foi possível ler os colégios: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Pagamentos: as cobranças do dia (uma vez por dia), os pagamentos por validar fora do prazo e os lembretes. */
  private async runPayments(slug: string) {
    try {
      const entry = await this.directory.findBySlug(slug);
      if (!entry) return;
      const db = this.connections.get(entry);
      const [ready] = await db.$queryRaw<{ ok: boolean }[]>`SELECT to_regclass('payments') IS NOT NULL AS ok`;
      if (!ready?.ok) return;
      const repo = new PrismaPaymentsRepository(db);
      const local = localNow("Africa/Luanda", new Date());
      const day = local.slice(0, 10);
      if (this.chargesDay.get(slug) !== day) {
        await this.payments.dailySync(repo);
        this.chargesDay.set(slug, day);
      }
      const tenant = { slug: entry.slug, name: entry.schoolName };
      await this.payments.overdue(repo, this.notifier.for(db, tenant));
      // lembretes das propinas, uma vez por dia a partir da hora escolhida (cada um fica reservado: não se repete)
      if (this.remindersDay.get(slug) !== day) {
        const sent = await this.reminders.daily(repo, new PrismaRemindersRepository(db), { familyEmail: (m) => this.notifier.familyEmail(tenant, { ...m, kind: m.kind ?? "PAYMENT_REMINDER" }) }, Number(local.slice(11, 13)));
        if (sent !== null) this.remindersDay.set(slug, day);
        if (sent) this.logger.log(`${slug}: lembretes de propinas a ${sent} família(s)`);
      }
    } catch (e) {
      this.logger.warn(`pagamentos falharam em ${slug}: ${(e as Error).message}`);
    }
  }

  /** Comunicação: os avisos agendados cuja hora chegou. */
  private async runAnnouncements(slug: string) {
    try {
      const entry = await this.directory.findBySlug(slug);
      if (!entry) return;
      const db = this.connections.get(entry);
      const [ready] = await db.$queryRaw<{ ok: boolean }[]>`SELECT to_regclass('announcements') IS NOT NULL AS ok`;
      if (!ready?.ok) return;
      const tenant = { slug: entry.slug, name: entry.schoolName };
      const n = await this.announcements.publishDue(PrismaAnnouncementsRepository.for(db), {
        staff: this.notifier.for(db, tenant),
        family: (accountId, m) => notifyFamily(db, { accountId, kind: m.kind, title: m.title, body: m.body, link: m.link, now: new Date() }),
      });
      if (n) this.logger.log(`${slug}: ${n} aviso(s) agendado(s) publicado(s)`);
    } catch (e) {
      this.logger.warn(`avisos agendados falharam em ${slug}: ${(e as Error).message}`);
    }
  }

  /** Os avisos das provas que ficaram por entregar (a entrega normal é logo a seguir a cada alteração). */
  private async runExamNotices(slug: string) {
    try {
      const entry = await this.directory.findBySlug(slug);
      if (!entry) return;
      const db = this.connections.get(entry);
      const [ready] = await db.$queryRaw<{ ok: boolean }[]>`SELECT to_regclass('exam_notices') IS NOT NULL AS ok`;
      if (!ready?.ok) return;
      const now = new Date();
      const repo = PrismaExamsRepository.for(db);
      if (!(await repo.pendingNotices(now))) return;
      const rules = await this.settings.rules(new PrismaAttendanceSettingsRepository(db));
      await this.examNotices.deliver(repo, this.notifier.for(db, { slug: entry.slug, name: entry.schoolName }), localNow(rules.timeZone, now).slice(0, 10), now);
    } catch (e) {
      this.logger.warn(`avisos das provas falharam em ${slug}: ${(e as Error).message}`);
    }
  }

  /** Os resumos diários de um colégio (à parte: uma falha no prazo das presenças não os impede). */
  private async runDigests(slug: string) {
    try {
      const entry = await this.directory.findBySlug(slug);
      if (!entry) return;
      const db = this.connections.get(entry);
      const [ready] = await db.$queryRaw<{ ok: boolean }[]>`SELECT (to_regclass('daily_digests') IS NOT NULL AND to_regclass('exam_notices') IS NOT NULL) AS ok`;
      if (!ready?.ok) {
        if (!this.missingDigests.has(slug)) this.logger.warn(`${slug}: faltam as migrações 0037/0038 (resumos diários, provas) — reinicie o provisioner (aplica-as ao arrancar).`);
        this.missingDigests.add(slug);
        return;
      }
      this.missingDigests.delete(slug);
      const tenant = { slug: entry.slug, name: entry.schoolName };
      await this.digests.run(
        new PrismaDigestsRepository(db),
        new PrismaDeadlineRepository(db),
        new PrismaAttendanceSettingsRepository(db),
        this.notifier.for(db, tenant),
        (m) => this.notifier.familyEmail(tenant, { ...m, kind: "FAMILY_DAILY_DIGEST" }),
        "SCHEDULER",
        new Date(),
      );
    } catch (e) {
      this.logger.warn(`resumos diários falharam em ${slug}: ${(e as Error).message}`);
    }
  }
}
