import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Gradebook, type GradebookViewer, MAX_MARKS_PER_SAVE } from "../application/Gradebook";
import { PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import { PrismaGradingSettingsRepository } from "../infrastructure/prisma-grading-settings";
import { GRADING_HTTP } from "./grading-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const num = z.number().finite();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const period = z.number().int().min(1).max(3);
const periodQuery = new ZodValidationPipe(z.object({ periodo: z.coerce.number().int().min(1).max(3).optional() }));
const yearQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional() }));
const confirmQuery = new ZodValidationPipe(z.object({ confirmar: z.enum(["true", "false"]).optional() }));
const fields = { typeId: z.uuid().nullish(), name: z.string().max(200), heldOn: day.nullish(), outOf: num.nullish(), weight: num.nullish() };
const createBody = z
  .object({ period, componentKey: z.string().regex(/^[a-z0-9-]{1,40}$/, "Componente inválido."), ...fields, examId: z.uuid().nullish() })
  .meta({
    title: "GradebookAssessment",
    description: "Uma avaliação num componente do modelo: elemento (componentes por elemento), data, cotação (vazio = na escala do modelo) e peso (média ponderada). Com examId regista uma prova do calendário publicado (nome por omissão e data vêm da prova).",
  });
const updateBody = z.object({ revision: z.number().int().min(1), ...fields }).meta({ title: "GradebookAssessmentUpdate", description: "O componente não muda; a cotação nova tem de caber nas notas já lançadas." });
const marksBody = z
  .object({
    marks: z.array(z.object({ studentId: z.uuid(), state: z.enum(["GRADED", "ABSENT", "ABSENT_JUSTIFIED", "EXEMPT"]).nullable(), score: num.nullish(), note: z.string().max(400).nullish() })).max(MAX_MARKS_PER_SAVE),
    reason: z.string().max(600).nullish(),
  })
  .meta({ title: "GradebookMarks", description: "Notas de uma avaliação: na cotação da avaliação (ou na escala). state null = retirar a nota (volta a por lançar)." });
const notesBody = z
  .object({ period, notes: z.array(z.object({ studentId: z.uuid(), level: z.string().max(40).nullish(), comment: z.string().max(2000).nullish() })).max(MAX_MARKS_PER_SAVE) })
  .meta({ title: "GradebookNotes", description: "Menção do período (modelos qualitativos) e apreciação escrita, por aluno." });

/**
 * CADERNETA DIGITAL. O professor da disciplina na turma lança (rotas `@TeacherMay`); o diretor de
 * turma e quem tem grading.access consultam. O school-api decide quem pode o quê em cada pedido.
 */
@ApiTags("Portal · Avaliação · Caderneta")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/grading")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class GradebookController {
  constructor(private readonly gradebook: Gradebook) {}
  private books(t: TenantContext) {
    return PrismaGradebookRepository.for(t.db);
  }
  private settings(t: TenantContext) {
    return PrismaGradingSettingsRepository.for(t.db);
  }
  private async viewer(t: TenantContext, u: SchoolAccess): Promise<GradebookViewer> {
    return { userId: u.id, support: !!u.support, canView: (await permissionsOf(t.db, u)).includes("grading.access") };
  }

  @Get("me/gradebooks")
  @TeacherMay()
  @ApiOperation({ summary: "As minhas cadernetas (disciplinas que leciono) e as das turmas que coordeno, no ano em curso" })
  async mine(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.gradebook.mine(this.books(t), await this.viewer(t, u)), GRADING_HTTP);
  }

  @Get("gradebooks")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Todas as cadernetas de um ano (?ano=): classe → turma → disciplina, com o professor e o andamento" })
  async overview(@CurrentTenant() t: TenantContext, @Query(yearQuery) q: { ano?: string }) {
    return this.gradebook.overview(this.books(t), q.ano);
  }

  @Get("gradebooks/:groupId/:subjectId")
  @TeacherMay()
  @ApiOperation({ summary: "Uma caderneta num período (?periodo=, por omissão o atual): avaliações, notas e a média de cada aluno (motor oficial)" })
  async view(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Param("subjectId", id) subjectId: string, @Query(periodQuery) q: { periodo?: number }) {
    return unwrap(await this.gradebook.view(this.books(t), this.settings(t), await this.viewer(t, u), groupId, subjectId, q.periodo), GRADING_HTTP);
  }

  @Get("gradebooks/:groupId/:subjectId/history")
  @TeacherMay()
  @ApiOperation({ summary: "O histórico da caderneta num período (?periodo=): quem criou, mudou ou apagou o quê" })
  async history(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Param("subjectId", id) subjectId: string, @Query(periodQuery) q: { periodo?: number }) {
    return unwrap(await this.gradebook.history(this.books(t), await this.viewer(t, u), groupId, subjectId, q.periodo ?? 1), GRADING_HTTP);
  }

  @Post("gradebooks/:groupId/:subjectId/assessments")
  @TeacherMay()
  @ApiOperation({ summary: "Criar uma avaliação (só o professor da disciplina na turma)" })
  @ApiBody({ schema: openApi(createBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Param("subjectId", id) subjectId: string, @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>) {
    return unwrap(await this.gradebook.createAssessment(this.books(t), this.settings(t), await this.viewer(t, u), groupId, subjectId, body), GRADING_HTTP);
  }

  @Patch("assessments/:id")
  @TeacherMay()
  @ApiOperation({ summary: "Alterar uma avaliação (nome, elemento, data, cotação, peso)" })
  @ApiBody({ schema: openApi(updateBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) assessmentId: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>) {
    return unwrap(await this.gradebook.updateAssessment(this.books(t), this.settings(t), await this.viewer(t, u), assessmentId, body), GRADING_HTTP);
  }

  @Delete("assessments/:id")
  @TeacherMay()
  @ApiOperation({ summary: "Apagar uma avaliação (com notas lançadas pede ?confirmar=true; fica no histórico)" })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) assessmentId: string, @Query(confirmQuery) q: { confirmar?: string }) {
    return unwrap(await this.gradebook.deleteAssessment(this.books(t), this.settings(t), await this.viewer(t, u), assessmentId, q.confirmar === "true"), GRADING_HTTP);
  }

  @Put("assessments/:id/marks")
  @TeacherMay()
  @ApiOperation({ summary: "Lançar ou corrigir as notas de uma avaliação (só regista no histórico o que mudou)" })
  @ApiBody({ schema: openApi(marksBody) })
  async marks(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) assessmentId: string, @Body(new ZodValidationPipe(marksBody)) body: z.infer<typeof marksBody>) {
    return unwrap(await this.gradebook.setMarks(this.books(t), this.settings(t), await this.viewer(t, u), assessmentId, body), GRADING_HTTP);
  }

  @Put("gradebooks/:groupId/:subjectId/notes")
  @TeacherMay()
  @ApiOperation({ summary: "Menção do período (modelos qualitativos) e apreciação escrita de cada aluno" })
  @ApiBody({ schema: openApi(notesBody) })
  async notes(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Param("subjectId", id) subjectId: string, @Body(new ZodValidationPipe(notesBody)) body: z.infer<typeof notesBody>) {
    return unwrap(await this.gradebook.setNotes(this.books(t), this.settings(t), await this.viewer(t, u), groupId, subjectId, body), GRADING_HTTP);
  }
}
