import { Body, Controller, Get, Logger, Param, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { AttendanceSettings } from "../application/AttendanceSettings";
import { Presence } from "../application/Presence";
import { StudentAlerts } from "../application/StudentAlerts";
import { localNow } from "../domain/presence";
import type { AttendanceRules } from "../domain/settings";
import { PrismaAttendanceSettingsRepository } from "../infrastructure/prisma-attendance-settings";
import { PrismaPresenceRepository } from "../infrastructure/prisma-presence";
import { PrismaStudentAttendanceRepository } from "../infrastructure/prisma-student-attendance";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { ATTENDANCE_HTTP } from "./attendance-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const dayPipe = new ZodValidationPipe(day);
const optDayPipe = new ZodValidationPipe(day.optional());
const optId = new ZodValidationPipe(z.uuid().optional());
const mark = z.object({ studentId: z.uuid(), status: z.enum(["PRESENTE", "AUSENTE", "ATRASADO", "FALTA_JUSTIFICADA"], { error: "Estado inválido." }), minutesLate: z.number().int().nullish(), note: z.string().max(200).nullish() });
const submitBody = z
  .object({ marks: z.array(mark).max(200), summary: z.string().max(4000).nullish() })
  .meta({ title: "LessonAttendance", description: "Todos os alunos da turma, cada um com o seu estado; e o sumário da aula (opcional; sem o campo, não se mexe)." });
const summaryBody = z.object({ summary: z.string().max(4000).nullable() }).meta({ title: "LessonSummary", description: "O sumário da aula (até 2000 caracteres; vazio = sem sumário)." });
const correctBody = z.object({ marks: z.array(mark).max(200), reason: z.string().max(300) }).meta({ title: "LessonAttendanceCorrection", description: "Correção pela gestão: todos os alunos registados e o motivo." });

const rulesOf = (settings: AttendanceSettings, t: TenantContext) => settings.rules(new PrismaAttendanceSettingsRepository(t.db));
const logger = new Logger("StudentAlerts");

/** Depois de gravar as presenças: os alertas de assiduidade (um erro aqui não desfaz o registo). */
async function checkAlerts(alerts: StudentAlerts, notifier: Notifier, t: TenantContext, rules: AttendanceRules, sessionId: string) {
  try {
    const notify = notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName });
    await alerts.afterSession(new PrismaStudentAttendanceRepository(t.db), rules, sessionId, localNow(rules.timeZone, new Date()).slice(0, 10), notify, (n) => notifyFamily(t.db, n));
  } catch (e) {
    logger.warn(`${t.entry.slug}: alertas de assiduidade falharam (${(e as Error).message})`);
  }
}

/**
 * Presenças — o PROFESSOR (conta ligada a um funcionário): as suas aulas, a lista da turma,
 * submeter e o histórico das suas turmas. Só o que é dele (a API confirma a aula e o dia).
 */
@ApiTags("Portal · Presenças (professor)")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance/me")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class MyPresenceController {
  constructor(
    private readonly presence: Presence,
    private readonly settings: AttendanceSettings,
    private readonly alerts: StudentAlerts,
    private readonly notifier: Notifier,
  ) {}

  @Get("lessons")
  @TeacherMay()
  @ApiOperation({ summary: "As minhas aulas de um dia (por omissão hoje), com o estado das presenças e o prazo" })
  async day(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query("data", optDayPipe) date?: string) {
    return unwrap(await this.presence.myDay(new PrismaPresenceRepository(t.db), await rulesOf(this.settings, t), u.id, date), ATTENDANCE_HTTP);
  }

  @Get("lessons/:lessonId")
  @TeacherMay()
  @ApiOperation({ summary: "Uma aula num dia: a lista da turma e as presenças (se já registadas)" })
  async lesson(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("lessonId", id) lessonId: string, @Query("data", dayPipe) date: string) {
    return unwrap(await this.presence.myLesson(new PrismaPresenceRepository(t.db), await rulesOf(this.settings, t), u.id, lessonId, date), ATTENDANCE_HTTP);
  }

  @Put("lessons/:lessonId")
  @TeacherMay()
  @ApiOperation({ summary: "Submeter (ou corrigir até ao fim do prazo) as presenças de uma aula" })
  @ApiBody({ schema: openApi(submitBody) })
  async submit(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("lessonId", id) lessonId: string, @Query("data", dayPipe) date: string, @Body(new ZodValidationPipe(submitBody)) body: z.infer<typeof submitBody>) {
    const rules = await rulesOf(this.settings, t);
    const r = unwrap(await this.presence.submit(new PrismaPresenceRepository(t.db), rules, { userId: u.id }, lessonId, date, body.marks, body.summary), ATTENDANCE_HTTP);
    await checkAlerts(this.alerts, this.notifier, t, rules, r.sessionId);
    return r;
  }

  @Put("sessions/:sessionId/summary")
  @TeacherMay()
  @ApiOperation({ summary: "Escrever ou corrigir o sumário de uma aula que registei (a qualquer momento)" })
  @ApiBody({ schema: openApi(summaryBody) })
  async summary(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("sessionId", id) sessionId: string, @Body(new ZodValidationPipe(summaryBody)) body: z.infer<typeof summaryBody>) {
    return unwrap(await this.presence.setMySummary(new PrismaPresenceRepository(t.db), u.id, sessionId, body.summary), ATTENDANCE_HTTP);
  }

  @Get("groups")
  @TeacherMay()
  @ApiOperation({ summary: "As minhas turmas (histórico de presenças)" })
  async groups(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.presence.myGroups(new PrismaPresenceRepository(t.db), u.id), ATTENDANCE_HTTP);
  }

  @Get("groups/:groupId")
  @TeacherMay()
  @ApiOperation({ summary: "Uma das minhas turmas: as aulas que registei e a assiduidade de cada aluno" })
  async group(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string) {
    return unwrap(await this.presence.myGroup(new PrismaPresenceRepository(t.db), u.id, groupId), ATTENDANCE_HTTP);
  }

  @Get("sessions/:sessionId")
  @TeacherMay()
  @ApiOperation({ summary: "Uma aula que registei (as presenças)" })
  async session(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("sessionId", id) sessionId: string) {
    return unwrap(await this.presence.mySession(new PrismaPresenceRepository(t.db), u.id, sessionId), ATTENDANCE_HTTP);
  }

  // ---------------------------------------------------------------- coordenação da turma

  @Get("coordination")
  @TeacherMay()
  @ApiOperation({ summary: "As turmas que coordeno" })
  async coordination(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.presence.coordination(new PrismaPresenceRepository(t.db), u.id), ATTENDANCE_HTTP);
  }

  @Get("coordination/groups/:groupId")
  @TeacherMay()
  @ApiOperation({ summary: "A assiduidade da turma que coordeno: aulas e sumários de todos os professores, alunos (faltas seguidas, alertas), disciplinas e aulas sem presenças" })
  async coordinatedGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string) {
    return unwrap(await this.presence.coordinatedGroup(new PrismaPresenceRepository(t.db), await rulesOf(this.settings, t), u.id, groupId), ATTENDANCE_HTTP);
  }

  @Get("coordination/sessions/:sessionId")
  @TeacherMay()
  @ApiOperation({ summary: "Uma aula da turma que coordeno (de qualquer professor): presenças e sumário" })
  async coordinatedSession(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("sessionId", id) sessionId: string) {
    return unwrap(await this.presence.coordinatedSession(new PrismaPresenceRepository(t.db), u.id, sessionId), ATTENDANCE_HTTP);
  }
}

/** Presenças dos alunos — a GESTÃO (pedagógico). Ver: attendance.students.view · corrigir: attendance.students.edit. */
@ApiTags("Portal · Presenças (gestão)")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/attendance/students")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class StudentPresenceController {
  constructor(
    private readonly presence: Presence,
    private readonly settings: AttendanceSettings,
    private readonly notifier: Notifier,
    private readonly alerts: StudentAlerts,
  ) {}

  @Get("groups")
  @RequirePermission("attendance.students.view")
  @ApiOperation({ summary: "Turmas do ano (o em curso por omissão) com o n.º de aulas registadas" })
  async groups(@CurrentTenant() t: TenantContext, @Query("ano", optId) yearId?: string) {
    return this.presence.groups(new PrismaPresenceRepository(t.db), await rulesOf(this.settings, t), yearId);
  }

  @Get("groups/:groupId")
  @RequirePermission("attendance.students.view")
  @ApiOperation({ summary: "Uma turma: as aulas registadas e a assiduidade de cada aluno" })
  async group(@CurrentTenant() t: TenantContext, @Param("groupId", id) groupId: string) {
    return unwrap(await this.presence.group(new PrismaPresenceRepository(t.db), await rulesOf(this.settings, t), groupId), ATTENDANCE_HTTP);
  }

  @Get("sessions/:sessionId")
  @RequirePermission("attendance.students.view")
  @ApiOperation({ summary: "Uma aula registada: presenças e histórico de alterações" })
  async session(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("sessionId", id) sessionId: string) {
    const canEdit = (await permissionsOf(t.db, u)).includes("attendance.students.edit");
    return unwrap(await this.presence.session(new PrismaPresenceRepository(t.db), { canEdit }, sessionId), ATTENDANCE_HTTP);
  }

  @Put("sessions/:sessionId")
  @RequirePermission("attendance.students.edit")
  @ApiOperation({ summary: "Corrigir as presenças de uma aula (com motivo)" })
  @ApiBody({ schema: openApi(correctBody) })
  async correct(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("sessionId", id) sessionId: string, @Body(new ZodValidationPipe(correctBody)) body: z.infer<typeof correctBody>) {
    const notify = this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName });
    const r = unwrap(await this.presence.correct(new PrismaPresenceRepository(t.db), { id: u.id, canEdit: true }, sessionId, body, notify), ATTENDANCE_HTTP);
    await checkAlerts(this.alerts, this.notifier, t, await rulesOf(this.settings, t), sessionId);
    return r;
  }
}
