import { Body, Controller, Get, Param, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { PedagogyActor } from "../application/ports";
import { Teaching } from "../application/Teaching";
import { PrismaTeachingRepository } from "../infrastructure/prisma-teaching";
import { PEDAGOGY_HTTP } from "./pedagogy.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const teacherBody = z.object({ employeeId: z.uuid().nullable() }).meta({ title: "TeacherAssign", description: "Professor (funcionário aprovado ou ativo); null = retirar." });
const yearQuery = z.object({ yearId: z.uuid().optional() });

const actorOf = (u: SchoolAccess): PedagogyActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/**
 * Professores: quem dá cada disciplina em cada turma, coordenadores de turma, carga e choques,
 * o horário de cada professor e "O meu horário". Ver: qualquer utilizador do colégio. Atribuir: direção.
 */
@ApiTags("Portal · Professores")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/pedagogy")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class TeachingController {
  constructor(private readonly teaching: Teaching) {}

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
  @ApiOperation({ summary: "Professores do ano (?yearId=; por omissão o ano em curso): carga, coordenações e choques" })
  async teachers(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.teachers(this.repo(t), q), PEDAGOGY_HTTP);
  }

  @Get("teachers/:employeeId/timetable")
  @ApiOperation({ summary: "Horário de um professor: dias, tempos, turmas, disciplinas e salas" })
  async teacherTimetable(@CurrentTenant() t: TenantContext, @Param("employeeId", id) employeeId: string, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.teacherTimetable(this.repo(t), employeeId, q), PEDAGOGY_HTTP);
  }

  @Get("my-timetable")
  @TeacherMay()
  @ApiOperation({ summary: "O meu horário (a conta tem de estar ligada a um professor)" })
  async myTimetable(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return unwrap(await this.teaching.myTimetable(this.repo(t), u.id, q), PEDAGOGY_HTTP);
  }
}
