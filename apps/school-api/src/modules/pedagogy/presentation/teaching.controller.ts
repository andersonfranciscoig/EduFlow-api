import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { PedagogyActor } from "../application/ports";
import { Teaching } from "../application/Teaching";
import { Timetable } from "../application/Timetable";
import { PrismaTeachingRepository } from "../infrastructure/prisma-teaching";
import { PrismaTimetableRepository } from "../infrastructure/prisma-timetable";
import { PEDAGOGY_HTTP } from "./pedagogy.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const teacherBody = z.object({ employeeId: z.uuid().nullable() }).meta({ title: "TeacherAssign", description: "Professor (funcionário aprovado ou ativo); null = retirar." });
const yearQuery = z.object({ yearId: z.uuid().optional() });
const qualificationBody = z
  .object({
    level: z.enum(["pre", "primario", "ciclo1", "ciclo2"], { error: "Escolha o tipo de ensino." }),
    grades: z.array(z.number().int().min(0).max(13)).min(1, { error: "Escolha pelo menos uma classe." }).max(14),
    courseIds: z.array(z.uuid()).max(50).optional(),
    subjectIds: z.array(z.uuid()).min(1, { error: "Escolha pelo menos uma disciplina." }).max(60),
  })
  .meta({ title: "TeacherQualification", description: "Tipo de ensino → classes (e cursos, no II Ciclo) → disciplinas." });
const applyTeachersBody = z
  .object({ assignments: z.array(z.object({ groupId: z.uuid(), subjectId: z.uuid(), employeeId: z.uuid() })).min(1).max(2000) })
  .meta({ title: "ApplyTeachers", description: "As atribuições da proposta a gravar." });
const applyCoordinatorsBody = z
  .object({ coordinators: z.array(z.object({ groupId: z.uuid(), employeeId: z.uuid() })).min(1).max(500) })
  .meta({ title: "ApplyCoordinators", description: "Os coordenadores da proposta a gravar." });

const actorOf = (u: SchoolAccess): PedagogyActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/**
 * Professores: quem dá cada disciplina em cada turma, coordenadores de turma, carga e choques,
 * o horário de cada professor e "O meu horário". Ver: qualquer utilizador do colégio. Atribuir: direção.
 * O papel RH vê a lista de professores, o horário e as habilitações de cada um (`@HrMay`), nada mais daqui.
 */
@ApiTags("Portal · Professores")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/pedagogy")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class TeachingController {
  constructor(
    private readonly teaching: Teaching,
    private readonly timetable: Timetable,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaTeachingRepository(t.db);
  }

  @Get("groups/:id/teaching")
  @ApiOperation({ summary: "Professores da turma: cada disciplina do plano com o seu professor, o coordenador e os choques" })
  async groupTeaching(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    return unwrap(await this.teaching.groupTeaching(this.repo(t), actorOf(u), groupId), PEDAGOGY_HTTP);
  }

  @Put("groups/:id/teachers/:subjectId")
  @ApiOperation({ summary: "Atribuir (ou retirar) o professor de uma disciplina na turma", description: "As aulas já marcadas passam a ser dele. Devolve avisos dos choques de horário que isso cria." })
  @ApiBody({ schema: openApi(teacherBody) })
  async assign(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("id", id) groupId: string,
    @Param("subjectId", id) subjectId: string,
    @Body(new ZodValidationPipe(teacherBody)) body: z.infer<typeof teacherBody>,
  ) {
    return unwrap(await this.teaching.assign(this.repo(t), actorOf(u), groupId, subjectId, body.employeeId), PEDAGOGY_HTTP);
  }

  @Put("groups/:id/coordinator")
  @ApiOperation({ summary: "Coordenador (diretor) de turma; null = sem coordenador" })
  @ApiBody({ schema: openApi(teacherBody) })
  async coordinator(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string, @Body(new ZodValidationPipe(teacherBody)) body: z.infer<typeof teacherBody>) {
    return unwrap(await this.teaching.setCoordinator(this.repo(t), actorOf(u), groupId, body.employeeId), PEDAGOGY_HTTP);
  }

  @Get("teachers")
  @HrMay()
  @ApiOperation({ summary: "Professores do ano (?yearId=; por omissão o ano em curso): carga, coordenações e choques" })
  async teachers(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.teachers(this.repo(t), actorOf(u), q), PEDAGOGY_HTTP);
  }

  @Get("teachers/:employeeId/timetable")
  @HrMay()
  @ApiOperation({ summary: "Horário de um professor: dias, tempos, turmas, disciplinas e salas" })
  async teacherTimetable(@CurrentTenant() t: TenantContext, @Param("employeeId", id) employeeId: string, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.teacherTimetable(this.repo(t), employeeId, q), PEDAGOGY_HTTP);
  }

  @Get("my-classes")
  @TeacherMay()
  @ApiOperation({ summary: "As minhas turmas: onde dou aulas ou que coordeno, e as disciplinas que leciono" })
  async myClasses(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.myClasses(this.repo(t), u.id, q), PEDAGOGY_HTTP);
  }

  @Get("my-classes/:id")
  @TeacherMay()
  @ApiOperation({
    summary: "Uma das minhas turmas: o horário completo (só leitura), as disciplinas e os professores",
    description: "Só turmas onde o professor dá aulas ou que coordena; as outras respondem 404.",
  })
  async myClass(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    const access = unwrap(await this.teaching.myGroupAccess(this.repo(t), u.id, groupId), PEDAGOGY_HTTP);
    const timetable = unwrap(await this.timetable.groupTimetable(new PrismaTimetableRepository(t.db), actorOf(u), groupId), PEDAGOGY_HTTP);
    return { ...timetable, canManage: false, mine: { subjectIds: access.subjectIds, coordinates: access.coordinates } };
  }

  @Get("teachers/:employeeId/qualifications")
  @HrMay()
  @ApiOperation({ summary: "Habilitações do professor (tipo de ensino → classes/cursos → disciplinas) e o catálogo para as escolher" })
  async qualifications(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("employeeId", id) employeeId: string) {
    return unwrap(await this.teaching.qualifications(this.repo(t), actorOf(u), employeeId), PEDAGOGY_HTTP);
  }

  @Post("teachers/:employeeId/qualifications")
  @ApiOperation({ summary: "Nova habilitação", description: "As disciplinas valem para todas as classes (e cursos) escolhidas. Cursos só no II Ciclo (obrigatórios)." })
  @ApiBody({ schema: openApi(qualificationBody) })
  async addQualification(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("employeeId", id) employeeId: string,
    @Body(new ZodValidationPipe(qualificationBody)) body: z.infer<typeof qualificationBody>,
  ) {
    return unwrap(await this.teaching.saveQualification(this.repo(t), actorOf(u), employeeId, body), PEDAGOGY_HTTP);
  }

  @Put("teachers/:employeeId/qualifications/:qualificationId")
  @ApiOperation({ summary: "Alterar uma habilitação" })
  @ApiBody({ schema: openApi(qualificationBody) })
  async updateQualification(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("employeeId", id) employeeId: string,
    @Param("qualificationId", id) qualificationId: string,
    @Body(new ZodValidationPipe(qualificationBody)) body: z.infer<typeof qualificationBody>,
  ) {
    return unwrap(await this.teaching.saveQualification(this.repo(t), actorOf(u), employeeId, body, qualificationId), PEDAGOGY_HTTP);
  }

  @Delete("teachers/:employeeId/qualifications/:qualificationId")
  @ApiOperation({ summary: "Retirar uma habilitação" })
  async removeQualification(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("employeeId", id) employeeId: string, @Param("qualificationId", id) qualificationId: string) {
    return unwrap(await this.teaching.removeQualification(this.repo(t), actorOf(u), employeeId, qualificationId), PEDAGOGY_HTTP);
  }

  @Get("years/:yearId/teaching/proposal")
  @ApiOperation({
    summary: "Proposta automática de professores (não grava)",
    description: "Para cada disciplina de cada turma sem professor: um habilitado, livre às horas das aulas já marcadas, com a menor carga.",
  })
  async proposeTeachers(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("yearId", id) yearId: string) {
    return unwrap(await this.teaching.proposeTeachers(this.repo(t), actorOf(u), yearId), PEDAGOGY_HTTP);
  }

  @Post("years/:yearId/teaching/apply")
  @ApiOperation({ summary: "Aplicar a proposta de professores", description: "Cada atribuição é confirmada contra o estado de agora; as que já não servem voltam em skipped." })
  @ApiBody({ schema: openApi(applyTeachersBody) })
  async applyTeachers(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("yearId", id) yearId: string,
    @Body(new ZodValidationPipe(applyTeachersBody)) body: z.infer<typeof applyTeachersBody>,
  ) {
    return unwrap(await this.teaching.applyTeachers(this.repo(t), actorOf(u), yearId, body.assignments), PEDAGOGY_HTTP);
  }

  @Get("years/:yearId/coordinators/proposal")
  @ApiOperation({
    summary: "Proposta automática de coordenadores (não grava)",
    description: "Para cada turma sem coordenador: um professor livre (não coordena nenhuma turma), primeiro quem já dá aulas na turma.",
  })
  async proposeCoordinators(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("yearId", id) yearId: string) {
    return unwrap(await this.teaching.proposeCoordinators(this.repo(t), actorOf(u), yearId), PEDAGOGY_HTTP);
  }

  @Post("years/:yearId/coordinators/apply")
  @ApiOperation({ summary: "Aplicar a proposta de coordenadores" })
  @ApiBody({ schema: openApi(applyCoordinatorsBody) })
  async applyCoordinators(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("yearId", id) yearId: string,
    @Body(new ZodValidationPipe(applyCoordinatorsBody)) body: z.infer<typeof applyCoordinatorsBody>,
  ) {
    return unwrap(await this.teaching.applyCoordinators(this.repo(t), actorOf(u), yearId, body.coordinators), PEDAGOGY_HTTP);
  }

  @Get("my-timetable")
  @TeacherMay()
  @ApiOperation({ summary: "O meu horário (a conta tem de estar ligada a um professor)" })
  async myTimetable(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.myTimetable(this.repo(t), u.id, q), PEDAGOGY_HTTP);
  }
}
