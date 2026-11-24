import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Put, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { Env } from "../../../config/env";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { isKind, type Kind, KINDS } from "../../notifications/domain/catalog";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { AttendanceSettings } from "../application/AttendanceSettings";
import { DIGEST_JOB, DigestJob } from "../application/DigestJob";
import { DIGEST_DELAY_MINUTES, DIGEST_WINDOW_HOURS } from "../domain/digest";
import { localNow } from "../domain/presence";
import { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import { PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import { type DigestRow, PrismaDigestsRepository } from "../infrastructure/prisma-digests";

const day = new ZodValidationPipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD."));
const kindPipe = new ZodValidationPipe(z.string().regex(/^[A-Z_]{3,40}$/, "Tipo inválido."));
const prefBody = z.object({ email: z.boolean() }).meta({ title: "FamilyNotificationPreference" });
const SHOWN = 30;

const item = (r: DigestRow) => ({ day: r.day, dueAt: r.dueAt, headline: r.headline, createdAt: r.createdAt.toISOString() });
const notFound = () => new NotFoundException({ code: "NOT_FOUND", message: "Não há resumo desse dia." });

/** Resumos diários da equipa (cada um vê os seus) e, para a gestão, o estado dos envios. */
@ApiTags("Portal · Resumos diários")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance/digests")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class DigestsController {
  constructor(
    private readonly job: DigestJob,
    private readonly notifier: Notifier,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get("me")
  @TeacherMay()
  @ApiOperation({ summary: "Os meus resumos diários (os últimos 30)" })
  async mine(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return { items: (await new PrismaDigestsRepository(t.db).list("STAFF", u.id, SHOWN)).map(item) };
  }

  @Get("me/:day")
  @TeacherMay()
  @ApiOperation({ summary: "O meu resumo de um dia" })
  async one(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("day", day) d: string) {
    const r = (await new PrismaDigestsRepository(t.db).list("STAFF", u.id, SHOWN)).find((x) => x.day === d);
    if (!r) throw notFound();
    return { ...item(r), sections: r.content.sections };
  }

  @Get("status")
  @RequirePermission("attendance.access")
  @ApiOperation({ summary: "Os resumos enviados por dia, as regras e as últimas execuções" })
  async status(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    const repo = new PrismaDigestsRepository(t.db);
    const [days, runs, perms] = await Promise.all([repo.stats(), new PrismaDeadlineRepository(t.db).runs(DIGEST_JOB, 10), permissionsOf(t.db, u)]);
    return {
      canRun: perms.includes("attendance.settings.manage"),
      automatic: this.config.get("JOBS_ENABLED", { infer: true }) === "true",
      delayMinutes: DIGEST_DELAY_MINUTES,
      windowHours: DIGEST_WINDOW_HOURS,
      days: days.map((x) => ({ day: x.day, staff: x.staff, family: x.family, emails: x.emails, emailsFailed: x.email_failed })),
      runs: runs.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, stats: r.stats, error: r.error, startedAt: r.started_at.toISOString() })),
    };
  }

  @Post("run")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.settings.manage")
  @ApiOperation({ summary: "Enviar agora os resumos já devidos (o mesmo que o ciclo automático faz; nunca repete)" })
  async run(@CurrentTenant() t: TenantContext) {
    const tenant = { slug: t.entry.slug, name: t.entry.schoolName };
    return this.job.run(
      new PrismaDigestsRepository(t.db),
      new PrismaDeadlineRepository(t.db),
      new PrismaAttendanceSettingsRepository(t.db),
      this.notifier.for(t.db, tenant),
      (m) => this.notifier.familyEmail(tenant, { ...m, kind: "FAMILY_DAILY_DIGEST" }),
      "MANUAL",
      new Date(),
    );
  }
}

/** Área da família: os resumos da conta (só dos alunos a que ainda tem acesso) e as preferências de email. */
@ApiTags("Área da família · Resumos diários")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyDigestsController {
  constructor(private readonly settings: AttendanceSettings) {}

  /** Um resumo antigo não mostra um aluno que a conta já não gere (ex.: fez 18 anos e passou a ter a própria conta). */
  private async visible(t: TenantContext, accountId: string) {
    const repo = new PrismaDigestsRepository(t.db);
    const rules = await this.settings.rules(new PrismaAttendanceSettingsRepository(t.db));
    const [rows, allowed] = await Promise.all([repo.list("FAMILY", accountId, SHOWN), repo.accessibleStudents(accountId, localNow(rules.timeZone, new Date()).slice(0, 10))]);
    return rows.flatMap((r) => {
      const hidden = r.content.sections.some((s) => s.studentId && !allowed.has(s.studentId));
      if (!hidden) return [r];
      const sections = r.content.sections.filter((s) => s.studentId && allowed.has(s.studentId));
      // o texto de abertura e os avisos podem falar do aluno que já não vê: não se mostram
      return sections.length ? [{ ...r, headline: "Resumo dos alunos que gere", content: { headline: "", sections } }] : [];
    });
  }

  @Get("digests")
  @ApiOperation({ summary: "Os resumos diários da conta (os últimos 30)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return { items: (await this.visible(t, f.account.id)).map(item) };
  }

  @Get("digests/:day")
  @ApiOperation({ summary: "O resumo de um dia" })
  async one(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("day", day) d: string) {
    const r = (await this.visible(t, f.account.id)).find((x) => x.day === d);
    if (!r) throw notFound();
    return { ...item(r), sections: r.content.sections };
  }

  @Get("notification-preferences")
  @ApiOperation({ summary: "Preferências de email da conta (os tipos da família que podem ir por email)" })
  async preferences(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    const repo = new PrismaDigestsRepository(t.db);
    const kinds = (Object.keys(KINDS) as Kind[]).filter((k) => KINDS[k].audience === "FAMILY" && KINDS[k].emailAvailable);
    const [types, prefs] = await Promise.all([repo.types(kinds), repo.familyPreferences(f.account.id)]);
    return {
      items: kinds.map((k) => ({
        kind: k,
        label: KINDS[k].label,
        hint: KINDS[k].hint,
        enabled: types.get(k)?.enabled ?? KINDS[k].defaultEnabled,
        schoolEmail: types.get(k)?.email ?? KINDS[k].defaultEmail,
        email: prefs.get(k) ?? true,
      })),
    };
  }

  @Put("notification-preferences/:kind")
  @ApiOperation({ summary: "Querer (ou não) o email de um tipo" })
  @ApiBody({ schema: openApi(prefBody) })
  async setPreference(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("kind", kindPipe) kind: string, @Body(new ZodValidationPipe(prefBody)) body: z.infer<typeof prefBody>) {
    if (!isKind(kind) || KINDS[kind].audience !== "FAMILY" || !KINDS[kind].emailAvailable) throw new UnprocessableEntityException({ code: "INVALID_INPUT", message: "Tipo de notificação desconhecido." });
    await new PrismaDigestsRepository(t.db).setFamilyPreference(f.account.id, kind, body.email, new Date());
    return { saved: true };
  }
}
