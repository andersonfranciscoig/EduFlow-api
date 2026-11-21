import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { Env } from "../../../config/env";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { AttendanceSettings } from "../application/AttendanceSettings";
import { DEADLINE_JOB, DeadlineJob } from "../application/DeadlineJob";
import { Pendings } from "../application/Pendings";
import { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import { PrismaDeadlineRepository } from "../infrastructure/prisma-deadline";
import { PrismaOccurrencesRepository } from "../infrastructure/prisma-occurrences";
import { PrismaPendingsRepository } from "../infrastructure/prisma-pendings";
import { PrismaPresenceRepository } from "../infrastructure/prisma-presence";
import { ATTENDANCE_HTTP } from "./attendance-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const listQuery = new ZodValidationPipe(z.object({ estado: z.string().max(20).optional(), professor: z.uuid().optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }));
const faultBody = z.object({ note: z.string().max(300).nullish() }).meta({ title: "PendingFault", description: "Registar falta ao professor (modelo do colégio: a aula ou o dia)." });
const dismissBody = z.object({ reason: z.string().max(300) }).meta({ title: "PendingDismiss", description: "Dispensar a aula pendente (motivo obrigatório)." });
const subBody = z.object({ lessonId: z.uuid(), day, substituteId: z.uuid(), reason: z.string().max(200).nullish() }).meta({ title: "Substitution" });
const candQuery = new ZodValidationPipe(z.object({ aula: z.uuid(), data: day }));

/**
 * RH · aulas sem presenças no prazo, substituições e o estado das tarefas automáticas.
 * Ver: attendance.teachers.view · decidir, substituir, verificar agora: attendance.teachers.manage.
 */
@ApiTags("Portal · Assiduidade")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
@HrMay()
export class PendingsController {
  constructor(
    private readonly pendings: Pendings,
    private readonly settings: AttendanceSettings,
    private readonly job: DeadlineJob,
    private readonly notifier: Notifier,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaPendingsRepository(t.db);
  }
  private rules(t: TenantContext) {
    return this.settings.rules(new PrismaAttendanceSettingsRepository(t.db));
  }
  private notify(t: TenantContext) {
    return this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName });
  }
  private async actor(t: TenantContext, u: SchoolAccess) {
    return { id: u.id, canManage: (await permissionsOf(t.db, u)).includes("attendance.teachers.manage") };
  }

  // ---------------------------------------------------------------- aulas pendentes

  @Get("pendings")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Aulas sem presenças no prazo (filtros: estado, professor, página) e a última verificação" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(listQuery) q: { estado?: string; professor?: string; pagina?: number }) {
    return this.pendings.list(this.repo(t), new PrismaDeadlineRepository(t.db), await this.actor(t, u), await this.rules(t), { status: q.estado, teacherId: q.professor, page: q.pagina });
  }

  @Post("pendings/:id/falta")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Registar falta ao professor (gestão manual)" })
  @ApiBody({ schema: openApi(faultBody) })
  async fault(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) pendingId: string, @Body(new ZodValidationPipe(faultBody)) body: z.infer<typeof faultBody>) {
    return unwrap(await this.pendings.fault(this.repo(t), new PrismaOccurrencesRepository(t.db), await this.actor(t, u), await this.rules(t), pendingId, body.note ?? null, this.notify(t)), ATTENDANCE_HTTP);
  }

  @Post("pendings/:id/dispensar")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Dispensar a aula pendente, com motivo" })
  @ApiBody({ schema: openApi(dismissBody) })
  async dismiss(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) pendingId: string, @Body(new ZodValidationPipe(dismissBody)) body: z.infer<typeof dismissBody>) {
    return unwrap(await this.pendings.dismiss(this.repo(t), await this.actor(t, u), pendingId, body.reason), ATTENDANCE_HTTP);
  }

  // ---------------------------------------------------------------- substituições

  @Get("substitutions")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Substituições (das últimas duas semanas em diante)" })
  async substitutions(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return { canManage: (await this.actor(t, u)).canManage, ...(await this.pendings.substitutions(this.repo(t), await this.rules(t))) };
  }

  @Get("substitutions/candidates")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Professores que podem substituir uma aula num dia (e quem está ocupado a essa hora)" })
  async candidates(@CurrentTenant() t: TenantContext, @Query(candQuery) q: { aula: string; data: string }) {
    return unwrap(await this.pendings.candidates(this.repo(t), new PrismaPresenceRepository(t.db), q.aula, q.data), ATTENDANCE_HTTP);
  }

  @Post("substitutions")
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Marcar uma substituição (o substituto regista as presenças dessa aula)" })
  @ApiBody({ schema: openApi(subBody) })
  async substitute(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(subBody)) body: z.infer<typeof subBody>) {
    return unwrap(await this.pendings.substitute(this.repo(t), new PrismaPresenceRepository(t.db), await this.actor(t, u), body, this.notify(t)), ATTENDANCE_HTTP);
  }

  @Delete("substitutions/:id")
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Retirar uma substituição (só antes de o substituto registar as presenças)" })
  async removeSubstitution(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) subId: string) {
    return unwrap(await this.pendings.removeSubstitution(this.repo(t), await this.actor(t, u), subId, this.notify(t)), ATTENDANCE_HTTP);
  }

  // ---------------------------------------------------------------- tarefas automáticas

  @Get("jobs")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Estado das tarefas automáticas (últimas execuções do prazo das presenças)" })
  async jobs(@CurrentTenant() t: TenantContext) {
    const runs = await new PrismaDeadlineRepository(t.db).runs(DEADLINE_JOB, 20);
    return {
      enabled: this.config.get("JOBS_ENABLED", { infer: true }) === "true",
      intervalSeconds: Math.round(this.config.get("JOBS_INTERVAL_MS", { infer: true }) / 1000),
      runs: runs.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, stats: r.stats, error: r.error, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null })),
    };
  }

  @Post("jobs/deadline")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Verificar o prazo agora (o mesmo que o ciclo automático faz)" })
  async runNow(@CurrentTenant() t: TenantContext) {
    return this.job.run(new PrismaDeadlineRepository(t.db), new PrismaAttendanceSettingsRepository(t.db), this.notify(t), "MANUAL", new Date());
  }
}
