import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, ParseIntPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { AttendanceSettings } from "../../attendance/application/AttendanceSettings";
import { PrismaAttendanceSettingsRepository } from "../../attendance/infrastructure/prisma-attendance-settings";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { AUTO, type ExamActor, Exams } from "../application/Exams";
import { ExamNotices } from "../application/ExamNotices";
import type { ExamErrorCode } from "../domain/exams";
import { PrismaExamsRepository } from "../infrastructure/prisma-exams";

export const EXAMS_HTTP: Partial<Record<ExamErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  YEAR_CLOSED: HttpStatus.CONFLICT,
  CONFLICTS: HttpStatus.CONFLICT,
  NEEDS_CONFIRMATION: HttpStatus.CONFLICT,
  EXAM_EXISTS: HttpStatus.CONFLICT,
};

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const time = z.string().regex(/^\d{2}:\d{2}$/, "Hora no formato HH:MM.");
const format = z.enum(["ESCRITA", "ORAL", "PRATICA", "OUTRA"], { error: "Escolha a modalidade." });
const yearQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional() }));
const modelBody = z.object({ items: z.array(z.object({ id: z.uuid().nullish(), name: z.string().max(100) })).max(20) }).meta({ title: "ExamModel", description: "As provas de um período, por ordem (a quantidade é o número de linhas)." });
const configBody = z
  .object({
    startsOn: day,
    endsOn: day,
    interrupts: z.boolean(),
    format,
    notes: z.string().max(1000).nullish(),
    groupIds: z.array(z.uuid()).max(300),
    subjects: z.array(z.object({ classId: z.uuid(), subjectIds: z.array(z.uuid()).max(60) })).max(60),
  })
  .meta({ title: "ExamSeasonConfig", description: "Datas, interrupção das aulas, modalidade habitual, turmas e disciplinas abrangidas (por classe)." });
const teacherId = z.union([z.uuid(), z.literal(AUTO)]).nullish();
const examFields = { teacherId, day, startsAt: time, endsAt: time, room: z.string().max(60).nullish(), format, notes: z.string().max(1000).nullish(), confirm: z.boolean().optional(), reason: z.string().max(300).nullish() };
const newExamBody = z
  .object({ groupIds: z.array(z.uuid()).min(1, "Escolha pelo menos uma turma.").max(40), subjectId: z.uuid(), ...examFields })
  .meta({ title: "NewExam", description: 'A prova de uma disciplina numa ou em várias turmas. teacherId: um professor, "AUTO" (o da disciplina em cada turma) ou null.' });
const checkBody = newExamBody.extend({ examId: z.uuid().nullish() }).meta({ title: "ExamCheck", description: "Verificar conflitos sem gravar." });
const examBody = z.object(examFields).meta({ title: "ExamUpdate" });
const reasonBody = z.object({ reason: z.string().max(300) }).meta({ title: "ExamReason" });
const publishBody = z.object({ confirm: z.boolean().optional() }).meta({ title: "ExamPublish" });
const extendBody = z.object({ endsOn: day, reason: z.string().max(300) }).meta({ title: "ExamExtend" });

/**
 * Calendário de provas. Ver: attendance.exams.view · preparar: attendance.exams.manage ·
 * publicar e alterar o publicado: attendance.exams.publish. O professor vê as suas (publicadas).
 */
@ApiTags("Portal · Calendário de provas")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/exams")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class ExamsController {
  private readonly logger = new Logger("Exams");

  constructor(
    private readonly exams: Exams,
    private readonly notices: ExamNotices,
    private readonly settings: AttendanceSettings,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaExamsRepository.for(t.db);
  }
  private async zone(t: TenantContext) {
    return (await this.settings.rules(new PrismaAttendanceSettingsRepository(t.db))).timeZone;
  }
  private async actor(t: TenantContext, u: SchoolAccess): Promise<ExamActor> {
    const p = await permissionsOf(t.db, u);
    return { id: u.support ? null : u.id, canManage: p.includes("attendance.exams.manage"), canPublish: p.includes("attendance.exams.publish") };
  }
  /** Os avisos já estão gravados: entregam-se a seguir, sem prender o pedido (o ciclo automático retoma o que falhar). */
  private deliver(t: TenantContext, zone: string) {
    const tenant = { slug: t.entry.slug, name: t.entry.schoolName };
    void this.notices.deliver(this.repo(t), this.notifier.for(t.db, tenant), this.exams.today(zone), new Date()).catch((e: Error) => this.logger.warn(`avisos das provas em ${tenant.slug}: ${e.message}`));
  }

  // ---------------------------------------------------------------- professor

  @Get("me")
  @TeacherMay()
  @ApiOperation({ summary: "Professor: as provas publicadas que lhe dizem respeito (a cargo, das suas disciplinas, das turmas que coordena)" })
  async mine(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.exams.mine(this.repo(t), await this.zone(t), u.id), EXAMS_HTTP);
  }

  // ---------------------------------------------------------------- ver

  @Get()
  @RequirePermission("attendance.exams.view")
  @ApiOperation({ summary: "As provas de cada período de avaliação de um ano letivo (?ano=)" })
  async overview(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(yearQuery) q: { ano?: string }) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    return this.exams.overview(this.repo(t), actor, zone, q.ano);
  }

  @Get("seasons/:id")
  @RequirePermission("attendance.exams.view")
  @ApiOperation({ summary: "Uma época: configuração, provas, provas em falta, conflitos e histórico" })
  async season(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) seasonId: string) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    return unwrap(await this.exams.season(this.repo(t), actor, zone, seasonId), EXAMS_HTTP);
  }

  // ---------------------------------------------------------------- preparar

  @Put("years/:id/periods/:position")
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Modelo de avaliação: quantas provas tem um período e como se chamam" })
  @ApiBody({ schema: openApi(modelBody) })
  async model(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Param("position", ParseIntPipe) position: number, @Body(new ZodValidationPipe(modelBody)) body: z.infer<typeof modelBody>) {
    return unwrap(await this.exams.setModel(this.repo(t), await this.actor(t, u), yearId, Math.min(Math.max(position, 1), 3), body.items), EXAMS_HTTP);
  }

  @Put("seasons/:id")
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Configurar uma época (datas, interrupção das aulas, modalidade, turmas e disciplinas)" })
  @ApiBody({ schema: openApi(configBody) })
  async configure(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) seasonId: string, @Body(new ZodValidationPipe(configBody)) body: z.infer<typeof configBody>) {
    return unwrap(await this.exams.configure(this.repo(t), await this.actor(t, u), seasonId, body), EXAMS_HTTP);
  }

  @Post("seasons/:id/check")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Verificar os conflitos de uma prova, sem gravar" })
  @ApiBody({ schema: openApi(checkBody) })
  async check(@CurrentTenant() t: TenantContext, @Param("id", id) seasonId: string, @Body(new ZodValidationPipe(checkBody)) body: z.infer<typeof checkBody>) {
    return unwrap(await this.exams.check(this.repo(t), await this.zone(t), seasonId, body), EXAMS_HTTP);
  }

  @Post("seasons/:id/exams")
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Marcar a prova de uma disciplina (numa ou em várias turmas); com avisos, pede confirm" })
  @ApiBody({ schema: openApi(newExamBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) seasonId: string, @Body(new ZodValidationPipe(newExamBody)) body: z.infer<typeof newExamBody>) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    const r = unwrap(await this.exams.create(this.repo(t), actor, zone, seasonId, body), EXAMS_HTTP);
    this.deliver(t, zone);
    return r;
  }

  @Put("items/:id")
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Alterar uma prova (com o calendário publicado: quem publica, com motivo)" })
  @ApiBody({ schema: openApi(examBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) examId: string, @Body(new ZodValidationPipe(examBody)) body: z.infer<typeof examBody>) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    const r = unwrap(await this.exams.update(this.repo(t), actor, zone, examId, body), EXAMS_HTTP);
    this.deliver(t, zone);
    return r;
  }

  @Delete("items/:id")
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Retirar uma prova (só enquanto a época está em preparação)" })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) examId: string) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    return unwrap(await this.exams.remove(this.repo(t), actor, zone, examId), EXAMS_HTTP);
  }

  @Post("items/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.exams.view", "attendance.exams.manage")
  @ApiOperation({ summary: "Cancelar uma prova, com motivo (fica no calendário como cancelada)" })
  @ApiBody({ schema: openApi(reasonBody) })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) examId: string, @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    const r = unwrap(await this.exams.cancel(this.repo(t), actor, zone, examId, body.reason), EXAMS_HTTP);
    this.deliver(t, zone);
    return r;
  }

  // ---------------------------------------------------------------- publicar

  @Post("seasons/:id/publish")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.exams.view", "attendance.exams.publish")
  @ApiOperation({ summary: "Publicar o calendário (verifica os conflitos; com avisos, pede confirm) e avisar professores e famílias" })
  @ApiBody({ schema: openApi(publishBody) })
  async publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) seasonId: string, @Body(new ZodValidationPipe(publishBody)) body: z.infer<typeof publishBody>) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    const r = unwrap(await this.exams.publish(this.repo(t), actor, zone, seasonId, !!body.confirm), EXAMS_HTTP);
    this.deliver(t, zone);
    return r;
  }

  @Post("seasons/:id/unpublish")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.exams.view", "attendance.exams.publish")
  @ApiOperation({ summary: "Voltar a pôr em preparação (só antes de começar), com motivo" })
  @ApiBody({ schema: openApi(reasonBody) })
  async unpublish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) seasonId: string, @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    const r = unwrap(await this.exams.unpublish(this.repo(t), actor, zone, seasonId, body.reason), EXAMS_HTTP);
    this.deliver(t, zone);
    return r;
  }

  @Post("seasons/:id/extend")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("attendance.exams.view", "attendance.exams.publish")
  @ApiOperation({ summary: "Adiar o fim de uma época publicada, com motivo" })
  @ApiBody({ schema: openApi(extendBody) })
  async extend(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) seasonId: string, @Body(new ZodValidationPipe(extendBody)) body: z.infer<typeof extendBody>) {
    const [actor, zone] = await Promise.all([this.actor(t, u), this.zone(t)]);
    const r = unwrap(await this.exams.extend(this.repo(t), actor, zone, seasonId, body.endsOn, body.reason), EXAMS_HTTP);
    this.deliver(t, zone);
    return r;
  }
}
