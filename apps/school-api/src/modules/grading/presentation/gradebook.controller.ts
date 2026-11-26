import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Logger, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
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
import { GradingNotices } from "../application/GradingNotices";
import { YearResults } from "../application/YearResults";
import { PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import { Notifier, type StaffNotify } from "../../notifications/infrastructure/notifier";
import { PrismaGradingSettingsRepository } from "../infrastructure/prisma-grading-settings";
import { GRADING_HTTP } from "./grading-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const num = z.number().finite();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const period = z.number().int().min(1).max(3);
/** 0 = "Final do ano" (nota final, exame e recuperação) */
const anyPeriod = z.number().int().min(0).max(3);
const periodQuery = new ZodValidationPipe(z.object({ periodo: z.coerce.number().int().min(0).max(3).optional() }));
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

const termsQuery = new ZodValidationPipe(z.object({ ano: z.uuid().optional(), periodo: z.coerce.number().int().min(0).max(3).optional() }));
const submitBody = z.object({ period: anyPeriod }).meta({ title: "GradebookTermSubmit", description: "period 0 = Final do ano." });
const moveBody = z.object({ period: anyPeriod, revision: z.number().int().min(1), reason: z.string().max(600).nullish() }).meta({ title: "GradebookTermMove", description: "revision = a do estado que se está a ver (duas pessoas não se pisam); motivo obrigatório ao devolver e ao reabrir." });
const publishBody = z.object({ groupId: z.uuid(), period: anyPeriod, subjectIds: z.array(z.uuid()).max(60).nullish() }).meta({ title: "GradingTermsPublish" });
const finalBody = z
  .object({
    marks: z
      .array(
        z.object({
          studentId: z.uuid(),
          examState: z.enum(["GRADED", "ABSENT", "ABSENT_JUSTIFIED"]).nullish(),
          examValue: num.nullish(),
          examParts: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), num.nullable()).nullish(),
          recovery: num.nullish(),
        }),
      )
      .max(MAX_MARKS_PER_SAVE),
  })
  .meta({ title: "GradebookFinalMarks", description: "Final do ano: exame (ou as provas do exame) e prova de recuperação de cada aluno. examState null e recovery null = retirar." });
const decisionBody = z
  .object({ groupId: z.uuid(), studentId: z.uuid(), outcome: z.enum(["PASSED", "RETAINED"]).nullable(), reason: z.string().max(600).nullish() })
  .meta({ title: "GradingYearDecision", description: "Deliberação da direção sobre o resultado do ano (com o motivo); outcome null = retirar a deliberação." });
const progressionBody = z
  .object({ maxNegatives: z.number().int().min(0).max(20).nullable(), coreSubjectIds: z.array(z.uuid()).max(30), maxCoreNegatives: z.number().int().min(0).max(20).nullable() })
  .meta({ title: "GradingProgression", description: "Regras de transição de um ensino: quantas negativas transitam e o limite nas disciplinas nucleares (null = sem regra)." });
const levelPipe = new ZodValidationPipe(z.enum(["pre", "primario", "ciclo1", "ciclo2"], { error: "Ensino desconhecido." }));

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
  private readonly logger = new Logger("GradingNotices");
  constructor(
    private readonly gradebook: Gradebook,
    private readonly notices: GradingNotices,
    private readonly notifier: Notifier,
    private readonly years: YearResults,
  ) {}

  // ---------------------------------------------------------------- final do ano e transição

  @Put("gradebooks/:groupId/:subjectId/final-marks")
  @TeacherMay()
  @ApiOperation({ summary: "Final do ano: lançar o exame (classes de exame) e a prova de recuperação (só para quem tem direito)" })
  @ApiBody({ schema: openApi(finalBody) })
  async finalMarks(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Param("subjectId", id) subjectId: string, @Body(new ZodValidationPipe(finalBody)) body: z.infer<typeof finalBody>) {
    return unwrap(await this.gradebook.setFinalMarks(this.books(t), this.settings(t), await this.viewer(t, u), groupId, subjectId, body), GRADING_HTTP);
  }

  @Get("progression")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "As regras de transição de cada ensino (negativas admitidas, disciplinas nucleares)" })
  async progression(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.years.progression(this.books(t), (await permissionsOf(t.db, u)).includes("grading.settings.manage"));
  }

  @Put("progression/:level")
  @RequirePermission("grading.settings.manage")
  @ApiOperation({ summary: "Definir as regras de transição de um ensino (recalcula o resultado das turmas com notas finais)" })
  @ApiBody({ schema: openApi(progressionBody) })
  async setProgression(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("level", levelPipe) level: string, @Body(new ZodValidationPipe(progressionBody)) body: z.infer<typeof progressionBody>) {
    return unwrap(await this.years.setProgression(this.books(t), { ...(await this.viewer(t, u)), canManage: true }, level, body), GRADING_HTTP);
  }

  @Get("results")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Resultado do ano de todas as turmas (?ano=): transitam, não transitam, em recuperação, por decidir" })
  async results(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(yearQuery) q: { ano?: string }) {
    return this.years.overview(this.books(t), await this.viewer(t, u), q.ano);
  }

  @Get("results/groups/:groupId")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "Uma turma: a nota final de cada disciplina de cada aluno, o resultado calculado (com as razões) e a deliberação" })
  async resultsGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string) {
    return unwrap(await this.years.group(this.books(t), await this.viewer(t, u), groupId), GRADING_HTTP);
  }

  @Post("results/decisions")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("grading.results.publish")
  @ApiOperation({ summary: "A direção delibera o resultado do ano de um aluno (com o motivo), ou retira a deliberação" })
  @ApiBody({ schema: openApi(decisionBody) })
  async decide(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(decisionBody)) body: z.infer<typeof decisionBody>) {
    return unwrap(await this.years.decide(this.books(t), await this.viewer(t, u), body), GRADING_HTTP);
  }
  /** Depois de submeter, validar, devolver, reabrir ou publicar: os avisos (um erro aqui não desfaz nada). */
  private async notice(t: TenantContext, work: (books: PrismaGradebookRepository, notify: StaffNotify) => Promise<unknown>) {
    try {
      await work(this.books(t), this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName }));
    } catch (e) {
      this.logger.warn(`${t.entry.slug}: aviso do fecho do período falhou (${(e as Error).message})`);
    }
  }
  private books(t: TenantContext) {
    return PrismaGradebookRepository.for(t.db);
  }
  private settings(t: TenantContext) {
    return PrismaGradingSettingsRepository.for(t.db);
  }
  private async viewer(t: TenantContext, u: SchoolAccess): Promise<GradebookViewer> {
    const p = await permissionsOf(t.db, u);
    return { userId: u.id, support: !!u.support, canView: p.includes("grading.access"), canValidate: p.includes("grading.results.validate"), canPublish: p.includes("grading.results.publish"), canRectify: p.includes("grading.results.rectify") };
  }

  // ---------------------------------------------------------------- fecho dos períodos

  @Get("terms")
  @RequirePermission("grading.access")
  @ApiOperation({ summary: "O estado das classificações de todas as turmas e disciplinas num período (?ano=&periodo=): em preparação, pendentes, validadas, publicadas" })
  async terms(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(termsQuery) q: { ano?: string; periodo?: number }) {
    return this.gradebook.termsOverview(this.books(t), await this.viewer(t, u), q.ano, q.periodo);
  }

  @Post("gradebooks/:groupId/:subjectId/term/submit")
  @HttpCode(HttpStatus.OK)
  @TeacherMay()
  @ApiOperation({ summary: "O professor submete as classificações do período para validação (todos os alunos com média; ficam congeladas)" })
  @ApiBody({ schema: openApi(submitBody) })
  async submit(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("groupId", id) groupId: string, @Param("subjectId", id) subjectId: string, @Body(new ZodValidationPipe(submitBody)) body: { period: number }) {
    const r = unwrap(await this.gradebook.submitTerm(this.books(t), this.settings(t), await this.viewer(t, u), groupId, subjectId, body.period), GRADING_HTTP);
    await this.notice(t, (books, notify) => this.notices.submitted(books, notify, { yearId: "", groupId, subjectId, period: body.period }));
    return r;
  }

  @Post("gradebooks/:groupId/:subjectId/term/:action")
  @HttpCode(HttpStatus.OK)
  @TeacherMay()
  @ApiOperation({ summary: "Validar (diretor de turma ou grading.results.validate), devolver ao professor (com motivo) ou reabrir para retificação (grading.results.rectify, com motivo)" })
  @ApiBody({ schema: openApi(moveBody) })
  async move(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("groupId", id) groupId: string,
    @Param("subjectId", id) subjectId: string,
    @Param("action", new ZodValidationPipe(z.enum(["validate", "return", "reopen"], { error: "Ação inválida." }))) action: "validate" | "return" | "reopen",
    @Body(new ZodValidationPipe(moveBody)) body: z.infer<typeof moveBody>,
  ) {
    const r = unwrap(await this.gradebook.moveTerm(this.books(t), await this.viewer(t, u), groupId, subjectId, { ...body, action }), GRADING_HTTP);
    const k = { yearId: "", groupId, subjectId, period: body.period };
    await this.notice(t, (books, notify) => (action === "validate" ? this.notices.validated(books, notify, k) : this.notices.returned(books, notify, k, action === "reopen", body.reason?.trim() || null)));
    return r;
  }

  @Post("terms/publish")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("grading.results.publish")
  @ApiOperation({ summary: "Publicar as classificações validadas de uma turma num período (todas ou só as disciplinas indicadas): as famílias passam a vê-las" })
  @ApiBody({ schema: openApi(publishBody) })
  async publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(publishBody)) body: z.infer<typeof publishBody>) {
    const r = unwrap(await this.gradebook.publishGroup(this.books(t), await this.viewer(t, u), body), GRADING_HTTP);
    // final do ano publicado: o resultado dos alunos da turma muda (a renovação lê-o)
    if (body.period === 0) await this.years.recompute(this.books(t), body.groupId);
    await this.notice(t, (books) => this.notices.published(books, body.groupId, body.period, r.subjects));
    return r;
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
