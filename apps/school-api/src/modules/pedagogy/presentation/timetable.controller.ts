import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { PedagogyActor } from "../application/ports";
import { Timetable } from "../application/Timetable";
import type { Shift } from "../domain/academic";
import { PrismaTimetableRepository } from "../infrastructure/prisma-timetable";
import { PEDAGOGY_HTTP } from "./pedagogy.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const shiftPipe = new ZodValidationPipe(z.enum(["MANHA", "TARDE", "NOITE"], { error: "Turno inválido." }));
const subjectBody = z
  .object({ name: z.string().min(2).max(60), code: z.string().min(2).max(6), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish() })
  .meta({ title: "Subject", description: "Disciplina do catálogo: nome, sigla (2–6, ex.: MAT) e cor no horário." });
const curriculumBody = z
  .object({ items: z.array(z.object({ subjectId: z.uuid(), weeklyPeriods: z.number().int().min(1).max(20) })).max(30) })
  .meta({ title: "Curriculum", description: "Plano curricular da classe: disciplinas e tempos por semana (substitui o atual)." });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora no formato HH:MM.");
const periodsBody = z
  .object({ items: z.array(z.object({ startsAt: time, endsAt: time, kind: z.enum(["AULA", "INTERVALO"]) })).min(1).max(15) })
  .meta({ title: "Periods", description: "Tempos do turno, por ordem (substitui os atuais; mantém as aulas marcadas por posição)." });
const lessonBody = z
  .object({ weekday: z.number().int().min(1).max(5), periodId: z.uuid(), subjectId: z.uuid().nullish(), room: z.string().max(40).nullish() })
  .meta({ title: "LessonSet", description: "Marca a aula de um tempo (subjectId null = limpar). Sala por omissão: a da turma." });

const actorOf = (u: SchoolAccess): PedagogyActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/**
 * Disciplinas, plano curricular, tempos letivos e horários das turmas.
 * Ver: qualquer utilizador do colégio. Alterar: direção (o suporte em só leitura é travado no guard).
 */
@ApiTags("Portal · Disciplinas e horários")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/pedagogy")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class TimetableController {
  constructor(private readonly timetable: Timetable) {}

  private repo(tenant: TenantContext) {
    return new PrismaTimetableRepository(tenant.db);
  }

  // ---------------------------------------------------------------- disciplinas

  @Get("subjects")
  @ApiOperation({ summary: "Catálogo de disciplinas (com planos e aulas onde são usadas)" })
  subjects(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.timetable.listSubjects(this.repo(t), actorOf(u));
  }

  @Post("subjects")
  @ApiOperation({ summary: "Criar disciplina" })
  @ApiBody({ schema: openApi(subjectBody) })
  async createSubject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(subjectBody)) body: z.infer<typeof subjectBody>) {
    return unwrap(await this.timetable.createSubject(this.repo(t), actorOf(u), body), PEDAGOGY_HTTP);
  }

  @Patch("subjects/:id")
  @ApiOperation({ summary: "Alterar disciplina (muda em todos os planos e horários)" })
  @ApiBody({ schema: openApi(subjectBody) })
  async updateSubject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) subjectId: string, @Body(new ZodValidationPipe(subjectBody)) body: z.infer<typeof subjectBody>) {
    return unwrap(await this.timetable.updateSubject(this.repo(t), actorOf(u), subjectId, body), PEDAGOGY_HTTP);
  }

  @Post("subjects/:id/archive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Arquivar disciplina (não entra em planos novos)" })
  async archiveSubject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) subjectId: string) {
    return unwrap(await this.timetable.setSubjectArchived(this.repo(t), actorOf(u), subjectId, true), PEDAGOGY_HTTP);
  }

  @Post("subjects/:id/restore")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reativar disciplina" })
  async restoreSubject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) subjectId: string) {
    return unwrap(await this.timetable.setSubjectArchived(this.repo(t), actorOf(u), subjectId, false), PEDAGOGY_HTTP);
  }

  @Delete("subjects/:id")
  @ApiOperation({ summary: "Eliminar disciplina (só sem planos nem aulas)" })
  async deleteSubject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) subjectId: string) {
    return unwrap(await this.timetable.deleteSubject(this.repo(t), actorOf(u), subjectId), PEDAGOGY_HTTP);
  }

  // ---------------------------------------------------------------- plano curricular

  @Get("years/:id/curricula")
  @ApiOperation({ summary: "Resumo do ano: planos curriculares (por classe) e aulas marcadas (por turma)" })
  yearCurricula(@CurrentTenant() t: TenantContext, @Param("id", id) yearId: string) {
    return this.timetable.yearCurricula(this.repo(t), yearId);
  }

  @Get("classes/:id/curriculum")
  @ApiOperation({ summary: "Plano curricular da classe (e tempos já marcados em cada turma)" })
  async curriculum(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) classId: string) {
    return unwrap(await this.timetable.classCurriculum(this.repo(t), actorOf(u), classId), PEDAGOGY_HTTP);
  }

  @Put("classes/:id/curriculum")
  @ApiOperation({ summary: "Definir o plano curricular da classe" })
  @ApiBody({ schema: openApi(curriculumBody) })
  async setCurriculum(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) classId: string, @Body(new ZodValidationPipe(curriculumBody)) body: z.infer<typeof curriculumBody>) {
    return unwrap(await this.timetable.setCurriculum(this.repo(t), actorOf(u), classId, body.items), PEDAGOGY_HTTP);
  }

  // ---------------------------------------------------------------- tempos letivos

  @Get("periods")
  @ApiOperation({ summary: "Tempos letivos de cada turno (manhã, tarde, noite)" })
  periods(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.timetable.periods(this.repo(t), actorOf(u));
  }

  @Put("periods/:shift")
  @ApiOperation({ summary: "Definir os tempos de um turno" })
  @ApiBody({ schema: openApi(periodsBody) })
  async setPeriods(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("shift", shiftPipe) shift: Shift, @Body(new ZodValidationPipe(periodsBody)) body: z.infer<typeof periodsBody>) {
    return unwrap(await this.timetable.setPeriods(this.repo(t), actorOf(u), shift, body.items), PEDAGOGY_HTTP);
  }

  // ---------------------------------------------------------------- horário da turma

  @Get("groups/:id/timetable")
  @ApiOperation({ summary: "Horário da turma (grelha, plano e progresso; professor: sem professor atribuído)" })
  async groupTimetable(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    return unwrap(await this.timetable.groupTimetable(this.repo(t), actorOf(u), groupId), PEDAGOGY_HTTP);
  }

  @Put("groups/:id/timetable")
  @ApiOperation({ summary: "Marcar/limpar a aula de um tempo", description: "409 WEEKLY_LIMIT (tempos do plano esgotados), ROOM_BUSY (sala ocupada por outra turma)." })
  @ApiBody({ schema: openApi(lessonBody) })
  async setLesson(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string, @Body(new ZodValidationPipe(lessonBody)) body: z.infer<typeof lessonBody>) {
    return unwrap(await this.timetable.setLesson(this.repo(t), actorOf(u), groupId, body), PEDAGOGY_HTTP);
  }
}
