import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { AttendanceSettings } from "../application/AttendanceSettings";
import { Justifications } from "../application/Justifications";
import { TeacherOccurrences } from "../application/TeacherOccurrences";
import { PrismaJustificationsRepository } from "../infrastructure/prisma-justifications";
import type { OccurrenceAction } from "../domain/occurrences";
import { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import { PrismaOccurrencesRepository } from "../infrastructure/prisma-occurrences";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { ATTENDANCE_HTTP } from "./attendance-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const dayPipe = new ZodValidationPipe(day);
const markBody = z
  .object({
    day,
    items: z.array(z.object({ lessonId: z.uuid().nullish(), kind: z.enum(["FALTA", "ATRASO"], { error: "Escolha falta ou atraso." }), minutesLate: z.number().int().nullish(), note: z.string().max(300).nullish() })).min(1).max(15),
  })
  .meta({ title: "TeacherOccurrenceMark", description: "Modelo por aula: uma linha por aula do horário desse dia (lessonId). Modelo por dia: uma linha sem aula." });
const actionBody = z
  .object({ reason: z.string().max(500), kind: z.enum(["FALTA", "ATRASO"]).nullish(), minutesLate: z.number().int().nullish() })
  .meta({ title: "TeacherOccurrenceAction", description: "Justificar (reason = justificação), alterar (kind, minutesLate), anular ou reabrir — sempre com o motivo." });
const listQuery = new ZodValidationPipe(
  z.object({ professor: z.uuid().optional(), estado: z.string().max(20).optional(), origem: z.string().max(20).optional(), de: day.optional(), ate: day.optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }),
);
const ACTIONS: Record<string, OccurrenceAction> = { justificar: "JUSTIFY", alterar: "CHANGE", anular: "CANCEL", reabrir: "REOPEN" };
const actionPipe = new ZodValidationPipe(z.enum(["justificar", "alterar", "anular", "reabrir"], { error: "Ação desconhecida." }));

/**
 * Faltas e atrasos dos professores — área do RH.
 * Ver: attendance.teachers.view · marcar e corrigir: attendance.teachers.manage. Professores não.
 */
@ApiTags("Portal · Assiduidade")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance/teachers")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
@HrMay()
export class TeacherOccurrencesController {
  constructor(
    private readonly occurrences: TeacherOccurrences,
    private readonly settings: AttendanceSettings,
    private readonly notifier: Notifier,
    private readonly justifications: Justifications,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaOccurrencesRepository(t.db);
  }
  private notify(t: TenantContext) {
    return this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName });
  }
  private rules(t: TenantContext) {
    return this.settings.rules(new PrismaAttendanceSettingsRepository(t.db));
  }
  private async actor(t: TenantContext, u: SchoolAccess) {
    return { id: u.id, canManage: (await permissionsOf(t.db, u)).includes("attendance.teachers.manage") };
  }

  @Get()
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Professores (com aulas no horário), contagens e o modelo do colégio" })
  async overview(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.occurrences.overview(this.repo(t), await this.actor(t, u), await this.rules(t));
  }

  @Get("occurrences")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Ocorrências (filtros: professor, estado, origem, de/até, página)" })
  list(@CurrentTenant() t: TenantContext, @Query(listQuery) q: { professor?: string; estado?: string; origem?: string; de?: string; ate?: string; pagina?: number }) {
    return this.occurrences.list(this.repo(t), { employeeId: q.professor, status: q.estado, source: q.origem, from: q.de, to: q.ate, page: q.pagina });
  }

  @Get("occurrences/:id")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "Uma ocorrência, as ações possíveis e o histórico (antes → depois, motivo)" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) occurrenceId: string) {
    const [d, justifications] = await Promise.all([this.occurrences.detail(this.repo(t), await this.actor(t, u), occurrenceId), this.justifications.forOccurrence(new PrismaJustificationsRepository(t.db), occurrenceId)]);
    return { ...unwrap(d, ATTENDANCE_HTTP), justifications };
  }

  @Post("occurrences/:id/:action")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Justificar, alterar, anular ou reabrir uma ocorrência" })
  @ApiBody({ schema: openApi(actionBody) })
  async act(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("id", id) occurrenceId: string,
    @Param("action", actionPipe) action: string,
    @Body(new ZodValidationPipe(actionBody)) body: z.infer<typeof actionBody>,
  ) {
    return unwrap(await this.occurrences.act(this.repo(t), await this.actor(t, u), occurrenceId, ACTIONS[action], body, this.notify(t)), ATTENDANCE_HTTP);
  }

  @Get(":employeeId/day")
  @RequirePermission("attendance.teachers.view")
  @ApiOperation({ summary: "O dia do professor: aulas do horário (ou o dia) e o que já está marcado" })
  async day(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("employeeId", id) employeeId: string, @Query("data", dayPipe) date: string) {
    return unwrap(await this.occurrences.day(this.repo(t), await this.actor(t, u), await this.rules(t), employeeId, date), ATTENDANCE_HTTP);
  }

  @Post(":employeeId/occurrences")
  @RequirePermission("attendance.teachers.manage")
  @ApiOperation({ summary: "Marcar faltas/atrasos de um professor num dia (segundo o modelo do colégio)" })
  @ApiBody({ schema: openApi(markBody) })
  async mark(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("employeeId", id) employeeId: string, @Body(new ZodValidationPipe(markBody)) body: z.infer<typeof markBody>) {
    return unwrap(await this.occurrences.mark(this.repo(t), await this.actor(t, u), await this.rules(t), employeeId, body, "MANUAL", this.notify(t)), ATTENDANCE_HTTP);
  }
}
