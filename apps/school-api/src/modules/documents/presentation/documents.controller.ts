import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, permissionsOf, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { DocumentRequests, type Notices } from "../application/DocumentRequests";
import { audiencesFor, DocumentTypes, type DocumentsViewer } from "../application/DocumentTypes";
import type { DocumentsErrorCode, RequestStatus, StaffAction } from "../domain/documents";
import { PrismaDocumentsRepository } from "../infrastructure/prisma-documents";

export const DOCUMENTS_HTTP: Partial<Record<DocumentsErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  NAME_TAKEN: HttpStatus.CONFLICT,
  CHANGED: HttpStatus.CONFLICT,
  NOT_AVAILABLE: HttpStatus.CONFLICT,
};

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const statusEnum = z.enum(["PENDING", "IN_REVIEW", "AWAITING_PAYMENT", "PROCESSING", "READY_PICKUP", "READY_DOWNLOAD", "COMPLETED", "REJECTED", "CANCELLED", "OPEN"]);
const field = z.object({ key: z.string().max(40).nullish(), label: z.string().max(200), kind: z.enum(["TEXT", "LONG_TEXT", "DATE", "NUMBER", "CHOICE"]), required: z.boolean(), options: z.array(z.string().max(200)).max(30).nullish(), hint: z.string().max(400).nullish() });
export const typeBody = z
  .object({
    audience: z.enum(["STUDENT", "EMPLOYEE"]),
    department: z.enum(["SECRETARIA", "PEDAGOGIA", "RH"]),
    category: z.string().max(200),
    name: z.string().max(300),
    description: z.string().max(2000).nullish(),
    requirements: z.string().max(2000).nullish(),
    method: z.enum(["AUTO", "EXTERNAL"]),
    pickup: z.boolean(),
    download: z.boolean(),
    fee: z.number().int().nullish(),
    slaDays: z.number().int(),
    requiresApproval: z.boolean(),
    fields: z.array(field).max(20),
    active: z.boolean(),
  })
  .meta({ title: "DocumentType", description: "Um documento que se pode pedir: público, departamento, categoria, método de emissão, levantamento/download, prazo (dias), aprovação e campos extra." });
const suggestedBody = z.object({ audience: z.enum(["STUDENT", "EMPLOYEE"]), names: z.array(z.string().max(200)).min(1).max(30) }).meta({ title: "DocumentTypesSuggested" });
export const requestBody = z
  .object({ typeId: z.uuid(), answers: z.record(z.string().max(40), z.string().max(2000)).nullish(), notes: z.string().max(1200).nullish() })
  .meta({ title: "DocumentRequestCreate", description: "O documento pedido, as respostas aos campos extra do tipo e uma observação." });
const staffRequestBody = requestBody.extend({ studentId: z.uuid().nullish(), employeeId: z.uuid().nullish() }).meta({ title: "DocumentRequestStaffCreate", description: "Ao balcão: em nome de um aluno (secretaria) ou de um funcionário (RH)." });
const moveBody = z.object({ revision: z.number().int().min(1), reason: z.string().max(600).nullish(), note: z.string().max(1200).nullish(), notify: z.boolean().nullish() }).meta({ title: "DocumentRequestMove", description: "revision = a do pedido que se está a ver; motivo obrigatório ao rejeitar e ao cancelar." });
const noteBody = z.object({ note: z.string().max(1200), internal: z.boolean() }).meta({ title: "DocumentRequestNote" });
const deliveryBody = z
  .object({ revision: z.number().int().min(1), receivedBy: z.string().max(240).nullish(), receivedByDocument: z.string().max(80).nullish(), relationship: z.enum(["SELF", "GUARDIAN", "AUTHORIZED"]), notes: z.string().max(600).nullish() })
  .meta({ title: "DocumentDelivery", description: "Quem recebeu (obrigatório), a relação com o beneficiário e, se for uma pessoa autorizada, o n.º do documento de identificação." });
export const cancelBody = z.object({ reason: z.string().max(600).nullish() }).meta({ title: "DocumentRequestCancel" });
const listQuery = new ZodValidationPipe(
  z.object({
    publico: z.enum(["STUDENT", "EMPLOYEE"]).optional(),
    estado: statusEnum.optional(),
    q: z.string().max(120).optional(),
    tipo: z.uuid().optional(),
    departamento: z.enum(["SECRETARIA", "PEDAGOGIA", "RH"]).optional(),
    classe: z.uuid().optional(),
    turma: z.uuid().optional(),
    de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pagina: z.coerce.number().int().min(1).max(1000).optional(),
  }),
);
const mineQuery = new ZodValidationPipe(z.object({ estado: statusEnum.optional(), q: z.string().max(120).optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }));
const actionPipe = new ZodValidationPipe(z.enum(["review", "process", "ready-pickup", "reject", "cancel"], { error: "Ação inválida." }));
const beneficiaryQuery = new ZodValidationPipe(z.object({ publico: z.enum(["STUDENT", "EMPLOYEE"]), q: z.string().min(2).max(80) }));

/**
 * DOCUMENTOS — equipa e funcionários.
 *  Secretaria/pedagogia (documents.*) e RH (hr.doc_*): tipos de documento, pedidos, passos, notas e entregas.
 *  Funcionário (`me/…`): os documentos profissionais que pode pedir e os seus pedidos.
 * As permissões de cada pedido dependem do seu público: decide-as o serviço.
 */
@ApiTags("Portal · Documentos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/documents")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
@HrMay()
export class DocumentsController {
  constructor(
    private readonly types: DocumentTypes,
    private readonly requests: DocumentRequests,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaDocumentsRepository.for(t.db);
  }
  private notices(t: TenantContext): Notices {
    return {
      staff: this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName }),
      family: { notify: (accountId, n) => notifyFamily(t.db, { accountId, ...n, now: new Date() }) },
    };
  }
  private async viewer(t: TenantContext, u: SchoolAccess): Promise<DocumentsViewer> {
    return { userId: u.id, support: !!u.support, name: u.fullName ?? "Equipa do colégio", permissions: await permissionsOf(t.db, u) };
  }
  /** As rotas de gestão: só quem tem alguma permissão dos documentos (alunos ou funcionários). */
  private async staff(t: TenantContext, u: SchoolAccess, what: "settings" | "view" = "view") {
    const v = await this.viewer(t, u);
    if (!audiencesFor(v, what).length && !(what === "view" && audiencesFor(v, "settings").length)) throw new ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para os pedidos de documentos. Peça acesso ao responsável do colégio." });
    return v;
  }

  // ---------------------------------------------------------------- tipos de documento

  @Get("types")
  @ApiOperation({ summary: "Os documentos que se podem pedir (alunos e/ou funcionários, conforme as permissões) e as sugestões" })
  async listTypes(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.types.overview(this.repo(t), await this.staff(t, u));
  }

  @Post("types")
  @ApiOperation({ summary: "Criar um documento (documents.settings.manage para alunos, hr.doc_types.manage para funcionários)" })
  @ApiBody({ schema: openApi(typeBody) })
  async createType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(typeBody)) body: z.infer<typeof typeBody>) {
    return unwrap(await this.types.create(this.repo(t), await this.staff(t, u, "settings"), body), DOCUMENTS_HTTP);
  }

  @Post("types/suggested")
  @ApiOperation({ summary: "Juntar documentos sugeridos (preparados pelo colégio, para levantar)" })
  @ApiBody({ schema: openApi(suggestedBody) })
  async suggested(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(suggestedBody)) body: z.infer<typeof suggestedBody>) {
    return unwrap(await this.types.addSuggested(this.repo(t), await this.staff(t, u, "settings"), body.audience, body.names), DOCUMENTS_HTTP);
  }

  @Put("types/:id")
  @ApiOperation({ summary: "Alterar um documento (os pedidos já feitos guardam a cópia de quando foram pedidos)" })
  @ApiBody({ schema: openApi(typeBody) })
  async updateType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string, @Body(new ZodValidationPipe(typeBody)) body: z.infer<typeof typeBody>) {
    return unwrap(await this.types.update(this.repo(t), await this.staff(t, u, "settings"), typeId, body), DOCUMENTS_HTTP);
  }

  @Delete("types/:id")
  @ApiOperation({ summary: "Apagar um documento sem pedidos; com pedidos, desativa-se" })
  async removeType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string) {
    return unwrap(await this.types.remove(this.repo(t), await this.staff(t, u, "settings"), typeId), DOCUMENTS_HTTP);
  }

  // ---------------------------------------------------------------- pedidos (equipa)

  @Get("requests")
  @ApiOperation({ summary: "Os pedidos (?publico=&estado=&q=&tipo=&departamento=&classe=&turma=&de=&ate=&pagina=): pesquisa por nome, n.º de aluno, turma, classe, tipo ou n.º do pedido" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(listQuery) q: { publico?: "STUDENT" | "EMPLOYEE"; estado?: RequestStatus | "OPEN"; q?: string; tipo?: string; departamento?: "SECRETARIA" | "PEDAGOGIA" | "RH"; classe?: string; turma?: string; de?: string; ate?: string; pagina?: number }) {
    return this.requests.staffList(this.repo(t), await this.staff(t, u), { audience: q.publico ?? null, status: q.estado ?? null, q: q.q?.trim() || null, typeId: q.tipo ?? null, department: q.departamento ?? null, classId: q.classe ?? null, groupId: q.turma ?? null, from: q.de ?? null, to: q.ate ?? null, page: q.pagina ?? 1 });
  }

  @Get("beneficiaries")
  @ApiOperation({ summary: "Procurar um aluno ou funcionário para registar um pedido ao balcão (?publico=&q=)" })
  async beneficiaries(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(beneficiaryQuery) q: { publico: "STUDENT" | "EMPLOYEE"; q: string }) {
    const v = await this.staff(t, u);
    if (!audiencesFor(v, "process").includes(q.publico)) throw new ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para registar estes pedidos." });
    const like = `%${q.q.trim()}%`;
    const rows =
      q.publico === "STUDENT"
        ? await t.db.$queryRaw<{ id: string; name: string; number: number | null; hint: string | null }[]>`
            SELECT s.id, s.full_name AS name, s.number, (SELECT g.name FROM enrollments e JOIN class_groups g ON g.id = e.group_id WHERE e.student_id = s.id AND e.status = 'ACTIVE' ORDER BY e.enrolled_at DESC LIMIT 1) AS hint
              FROM students s WHERE s.full_name ILIKE ${like} OR lpad(s.number::text, 5, '0') ILIKE ${like} ORDER BY lower(s.full_name) LIMIT 15`
        : await t.db.$queryRaw<{ id: string; name: string; number: number | null; hint: string | null }[]>`
            SELECT e.id, e.full_name AS name, e.number, e.job_title AS hint FROM employees e
             WHERE e.status IN ('APPROVED','ACTIVE','SUSPENDED','TERMINATED') AND (e.full_name ILIKE ${like} OR e.number::text ILIKE ${like}) ORDER BY lower(e.full_name) LIMIT 15`;
    return { items: rows.map((r) => ({ id: r.id, name: r.name, number: r.number === null ? null : String(r.number).padStart(q.publico === "STUDENT" ? 5 : 4, "0"), hint: r.hint })) };
  }

  @Post("requests")
  @ApiOperation({ summary: "Registar um pedido ao balcão, em nome de um aluno ou de um funcionário" })
  @ApiBody({ schema: openApi(staffRequestBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(staffRequestBody)) body: z.infer<typeof staffRequestBody>) {
    return unwrap(await this.requests.staffCreate(this.repo(t), this.notices(t), await this.staff(t, u), body), DOCUMENTS_HTTP);
  }

  @Get("requests/:id")
  @ApiOperation({ summary: "Um pedido: dados, respostas, histórico (com as notas internas), entrega e o que se pode fazer" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string) {
    return unwrap(await this.requests.staffDetail(this.repo(t), await this.staff(t, u), requestId), DOCUMENTS_HTTP);
  }

  @Post("requests/:id/notes")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Uma nota no pedido: interna (só a equipa) ou para quem pediu (avisa)" })
  @ApiBody({ schema: openApi(noteBody) })
  async note(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(noteBody)) body: z.infer<typeof noteBody>) {
    return unwrap(await this.requests.staffNote(this.repo(t), this.notices(t), await this.staff(t, u), requestId, body), DOCUMENTS_HTTP);
  }

  @Post("requests/:id/delivery")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirmar a entrega física: quem recebeu (obrigatório), a relação e, se autorizado, o documento de identificação" })
  @ApiBody({ schema: openApi(deliveryBody) })
  async deliver(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(deliveryBody)) body: z.infer<typeof deliveryBody>) {
    return unwrap(await this.requests.staffDeliver(this.repo(t), this.notices(t), await this.staff(t, u), requestId, body), DOCUMENTS_HTTP);
  }

  @Post("requests/:id/:action")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Um passo do pedido: review (analisar), process (preparar), ready-pickup (pronto a levantar), reject e cancel (com motivo)" })
  @ApiBody({ schema: openApi(moveBody) })
  async move(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Param("action", actionPipe) action: string, @Body(new ZodValidationPipe(moveBody)) body: z.infer<typeof moveBody>) {
    const a = action.replace("-", "_") as StaffAction;
    return unwrap(await this.requests.staffMove(this.repo(t), this.notices(t), await this.staff(t, u), requestId, a, { revision: body.revision, reason: body.reason, note: body.note, notify: !!body.notify }), DOCUMENTS_HTTP);
  }

  // ---------------------------------------------------------------- o funcionário (os seus documentos)

  @Get("me/types")
  @TeacherMay()
  @ApiOperation({ summary: "Os documentos profissionais que posso pedir (funcionário com ficha no RH)" })
  async mineTypes(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.requests.mineCatalog(this.repo(t), u.id), DOCUMENTS_HTTP);
  }

  @Post("me/requests")
  @TeacherMay()
  @ApiOperation({ summary: "Pedir um documento profissional (para mim)" })
  @ApiBody({ schema: openApi(requestBody) })
  async mineCreate(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(requestBody)) body: z.infer<typeof requestBody>) {
    return unwrap(await this.requests.mineCreate(this.repo(t), this.notices(t), await this.viewer(t, u), body), DOCUMENTS_HTTP);
  }

  @Get("me/requests")
  @TeacherMay()
  @ApiOperation({ summary: "Os meus pedidos de documentos (?estado=&q=&pagina=)" })
  async mineList(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(mineQuery) q: { estado?: RequestStatus | "OPEN"; q?: string; pagina?: number }) {
    return this.requests.mineList(this.repo(t), u.id, { status: q.estado, q: q.q, page: q.pagina });
  }

  @Get("me/requests/:id")
  @TeacherMay()
  @ApiOperation({ summary: "Um dos meus pedidos, com o histórico" })
  async mineDetail(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string) {
    return unwrap(await this.requests.mineDetail(this.repo(t), u.id, requestId), DOCUMENTS_HTTP);
  }

  @Post("me/requests/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @TeacherMay()
  @ApiOperation({ summary: "Cancelar um pedido meu (enquanto o colégio ainda não o começou a preparar)" })
  @ApiBody({ schema: openApi(cancelBody) })
  async mineCancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(cancelBody)) body: z.infer<typeof cancelBody>) {
    return unwrap(await this.requests.mineCancel(this.repo(t), this.notices(t), await this.viewer(t, u), requestId, body.reason ?? null), DOCUMENTS_HTTP);
  }
}
