import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import type { Permission } from "../../identity/domain/permissions";
import { permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { type Editor, Employees } from "../application/Employees";
import type { EmployeeRow } from "../application/employee-ports";
import { hrError } from "../domain/form";
import { PrismaUserAdminRepository } from "../../identity/infrastructure/user-admin-repository";
import { PortalAccess } from "../application/PortalAccess";
import { HrFileStores } from "../infrastructure/hr-file-store";
import { PrismaPortalAccess } from "../infrastructure/prisma-portal-access";
import { PrismaApplicantAccess, PrismaEmployeeRepository } from "../infrastructure/prisma-employees";
import { PrismaHrSettingsRepository } from "../infrastructure/prisma-hr-settings";
import { PrismaRegistrationRepository } from "../infrastructure/prisma-registration";
import { HR_HTTP } from "./hr-settings.controller";

const MINUTE = 60_000;
/** O maior documento configurável é 20 MB (o caso de uso confirma o limite de cada um). */
const MAX_UPLOAD = 20 * 1024 * 1024;
const SESSION_HEADER = "x-hr-session";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const step = new ZodValidationPipe(z.enum(["personal", "academic", "professional", "documents"], { error: "Passo inválido." }));
const tokenBody = z.object({ token: z.string().max(100) }).meta({ title: "HrInviteToken", description: "Token do link do convite." });
const loginBody = z.object({ token: z.string().max(100), password: z.string().min(1).max(128) }).meta({ title: "HrInviteLogin", description: "Token do link + palavra-passe escolhida no pedido." });
const stepBody = z
  .object({
    revision: z.number().int().min(0),
    values: z.unknown().optional(),
    complete: z.boolean().default(false),
    lastStep: z.string().max(20).nullish(),
  })
  .meta({
    title: "HrEmployeeStep",
    description:
      "Gravação de um passo. `values`: dados pessoais = { chave: valor }; formação/profissional = [ { idDoCampo: valor } ] (um registo por elemento). `complete` exige os obrigatórios. 409 REVISION_CONFLICT se a revisão não for a atual.",
  });
const uploadBody = z.object({ slot: z.enum(["PHOTO", "DOCUMENT", "FIELD"]), itemId: z.uuid().nullish() });
const revisionBody = z.object({ revision: z.number().int().min(0) }).meta({ title: "HrRevision" });
const createBody = z
  .object({ fullName: z.string().min(1).max(120), email: z.string().max(254).nullish(), phone: z.string().max(30).nullish(), employeeTypeId: z.uuid().nullish() })
  .meta({ title: "HrEmployeeCreate", description: "Cadastro criado pelo RH (fica em rascunho para preencher)." });
const approveBody = z.object({ jobTitle: z.string().max(120).nullish(), department: z.string().max(120).nullish() }).meta({ title: "HrEmployeeApprove" });
const reasonBody = z.object({ reason: z.string().max(500), notify: z.boolean().default(false) }).meta({ title: "HrEmployeeReason" });
const employmentBody = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "TERMINATED"]), reason: z.string().max(500).nullish() }).meta({ title: "HrEmployment" });
const adminBody = z.object({ jobTitle: z.string().max(120).nullish(), department: z.string().max(120).nullish() }).meta({ title: "HrEmployeeAdmin" });
const listQuery = z.object({ status: z.string().max(30).optional(), q: z.string().max(80).optional(), type: z.uuid().optional(), page: z.coerce.number().int().min(1).max(10_000).optional() });

type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;
const Upload = () => UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD, files: 1, fields: 4 } }));

const school = (t: TenantContext) => ({ slug: t.entry.slug, name: t.entry.schoolName });
const actorOf = (u: SchoolAccess) => (u.support ? { id: null, name: null } : { id: u.id, name: u.fullName });

/** Entrega um ficheiro decifrado: imagens e PDF abrem no navegador, o resto descarrega. */
function sendFile(res: Response, f: { fileName: string; mimeType: string; content: Buffer }) {
  const inline = /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.mimeType);
  const ascii = f.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  res.set({
    "Content-Type": f.mimeType,
    "Content-Length": String(f.content.length),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  return new StreamableFile(f.content);
}

/**
 * Formulário de cadastro pelo convite (sem conta no portal): o link + a palavra-passe do pedido
 * abrem uma sessão curta, enviada pelo servidor do portal no cabeçalho X-Hr-Session.
 * O colégio vem do Host/X-Tenant; a pessoa só chega ao SEU cadastro.
 */
@ApiTags("Portal público · Cadastro de funcionário")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiHeader({ name: "X-Hr-Session", required: false, description: "Sessão do formulário (depois de entrar com o convite)." })
@Controller("v1/public/hr/cadastro")
@UseGuards(TenantGuard)
export class ApplicantFormController {
  constructor(
    private readonly employees: Employees,
    private readonly stores: HrFileStores,
  ) {}

  private repos(t: TenantContext) {
    return { repo: new PrismaEmployeeRepository(t.db), access: new PrismaApplicantAccess(t.db) };
  }

  private async me(t: TenantContext, session: string | undefined): Promise<{ repo: PrismaEmployeeRepository; e: EmployeeRow }> {
    const { repo, access } = this.repos(t);
    return { repo, e: unwrap(await this.employees.applicant(access, repo, session), HR_HTTP) };
  }

  @Post("invite")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: "Validar o link do convite", description: "404 INVITE_INVALID, 410 INVITE_EXPIRED (o RH é avisado uma vez)." })
  @ApiBody({ schema: openApi(tokenBody) })
  async invite(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(tokenBody)) body: z.infer<typeof tokenBody>) {
    const { repo, access } = this.repos(t);
    return unwrap(await this.employees.inviteInfo(access, repo, school(t), body.token), HR_HTTP);
  }

  @Post("session")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Entrar com o link + palavra-passe", description: "5 tentativas erradas bloqueiam o convite 15 min. Devolve a sessão (2 h, renovada enquanto trabalha)." })
  @ApiBody({ schema: openApi(loginBody) })
  async login(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(loginBody)) body: z.infer<typeof loginBody>) {
    const { repo, access } = this.repos(t);
    return unwrap(await this.employees.login(access, repo, new PrismaHrSettingsRepository(t.db), school(t), body), HR_HTTP);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Terminar a sessão do formulário" })
  logout(@CurrentTenant() t: TenantContext, @Headers(SESSION_HEADER) session?: string) {
    return this.employees.logout(new PrismaApplicantAccess(t.db), session);
  }

  @Get()
  @Throttle({ default: { limit: 120, ttl: MINUTE } })
  @ApiOperation({ summary: "O meu cadastro: formulário da versão, passos, respostas, ficheiros e o que falta" })
  async view(@CurrentTenant() t: TenantContext, @Headers(SESSION_HEADER) session?: string) {
    const { e } = await this.me(t, session);
    return { school: t.entry.schoolName, employee: this.employees.view(e), storageReady: this.stores.for(t.entry).ready };
  }

  @Put("steps/:step")
  @Throttle({ default: { limit: 240, ttl: MINUTE } })
  @ApiOperation({ summary: "Gravar um passo (gravação automática ou concluir)" })
  @ApiBody({ schema: openApi(stepBody) })
  async save(@CurrentTenant() t: TenantContext, @Param("step", step) key: string, @Body(new ZodValidationPipe(stepBody)) body: z.infer<typeof stepBody>, @Headers(SESSION_HEADER) session?: string) {
    const { repo, e } = await this.me(t, session);
    return unwrap(await this.employees.saveStep(repo, e, { kind: "applicant" }, key, body), HR_HTTP);
  }

  @Post("documents")
  @Throttle({ default: { limit: 60, ttl: MINUTE } })
  @Upload()
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Enviar um ficheiro (fotografia, documento pedido ou campo de ficheiro)", description: "O formato confirma-se pelos bytes; cifrado antes de ir para o armazenamento." })
  async upload(@CurrentTenant() t: TenantContext, @UploadedFile() file: Upload, @Body(new ZodValidationPipe(uploadBody)) body: z.infer<typeof uploadBody>, @Headers(SESSION_HEADER) session?: string) {
    const { repo, e } = await this.me(t, session);
    return unwrap(await this.employees.upload(repo, this.stores.for(t.entry), e, { kind: "applicant" }, { ...body, file }), HR_HTTP);
  }

  @Get("documents/:docId")
  @ApiOperation({ summary: "Ver um ficheiro do meu cadastro" })
  async file(@CurrentTenant() t: TenantContext, @Param("docId", id) docId: string, @Res({ passthrough: true }) res: Response, @Headers(SESSION_HEADER) session?: string) {
    const { e } = await this.me(t, session);
    return sendFile(res, unwrap(await this.employees.readFile(this.stores.for(t.entry), e, docId), HR_HTTP));
  }

  @Delete("documents/:docId")
  @ApiOperation({ summary: "Retirar um ficheiro do meu cadastro" })
  async remove(@CurrentTenant() t: TenantContext, @Param("docId", id) docId: string, @Headers(SESSION_HEADER) session?: string) {
    const { repo, e } = await this.me(t, session);
    return unwrap(await this.employees.removeFile(repo, this.stores.for(t.entry), e, { kind: "applicant" }, docId), HR_HTTP);
  }

  @Post("submit")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: "Submeter o cadastro", description: "422 INCOMPLETE (meta.issues por passo) se faltar algo; o RH é avisado." })
  @ApiBody({ schema: openApi(revisionBody) })
  async submit(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(revisionBody)) body: z.infer<typeof revisionBody>, @Headers(SESSION_HEADER) session?: string) {
    const { repo, e } = await this.me(t, session);
    return unwrap(await this.employees.submit(repo, this.stores.for(t.entry), e, { kind: "applicant" }, school(t), body), HR_HTTP);
  }
}

/**
 * Funcionários na área de Recursos Humanos. Consultar: hr.employees.view; o resto conforme
 * a ação (criar, editar, aprovar, rejeitar). Quem criou um rascunho pode preenchê-lo.
 */
@ApiTags("Portal · Recursos Humanos · Funcionários")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/hr/employees")
@UseGuards(TenantGuard, SchoolAuthGuard)
export class EmployeesController {
  constructor(
    private readonly employees: Employees,
    private readonly stores: HrFileStores,
    private readonly access: PortalAccess,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaEmployeeRepository(t.db);
  }

  /** Dar/retirar acesso ao portal: um utilizador do colégio (nunca uma sessão de suporte). */
  private staff(u: SchoolAccess) {
    if (u.support) throw new ForbiddenException({ code: "FORBIDDEN", message: "Numa sessão de suporte não se dá acesso ao portal." });
    return { id: u.id, name: u.fullName };
  }

  @Post(":id/portal-access")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.employees.edit")
  @ApiOperation({
    summary: "Dar acesso ao portal (conta de professor ligada ao funcionário)",
    description: "Convite por email (ativação normal: código → senha → 2FA). Se já existir uma conta com o email, liga-se a ela.",
  })
  async grantAccess(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string) {
    return unwrap(await this.access.grant(new PrismaPortalAccess(t.db), new PrismaUserAdminRepository(t.db), this.staff(u), school(t), employeeId), HR_HTTP);
  }

  @Delete(":id/portal-access")
  @RequirePermission("hr.employees.edit")
  @ApiOperation({ summary: "Retirar o acesso ao portal (convite cancelado ou conta suspensa)" })
  async revokeAccess(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string) {
    return unwrap(await this.access.revoke(new PrismaPortalAccess(t.db), new PrismaUserAdminRepository(t.db), this.staff(u), employeeId), HR_HTTP);
  }

  private async load(t: TenantContext, employeeId: string) {
    const repo = this.repo(t);
    const e = await repo.find(employeeId);
    if (!e) unwrap({ ok: false, error: hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado.") }, HR_HTTP);
    return { repo, e: e! };
  }

  /** Editar os dados: hr.employees.edit, ou quem o criou enquanto é rascunho (hr.employees.create). */
  private async editor(t: TenantContext, u: SchoolAccess, e: EmployeeRow): Promise<Editor> {
    const have = await permissionsOf(t.db, u);
    const can = (p: Permission) => have.includes(p);
    const ownDraft = e.status === "DRAFT" && !e.requestId && can("hr.employees.create");
    if (!can("hr.employees.edit") && !ownDraft) throw new ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para editar funcionários." });
    return { kind: "hr", actor: actorOf(u) };
  }

  @Get()
  @RequirePermission("hr.employees.view")
  @ApiOperation({ summary: "Funcionários (?status=, ?q=, ?type=, ?page=) com contagens por estado" })
  list(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.employees.list(this.repo(t), q);
  }

  @Post()
  @RequirePermission("hr.employees.create")
  @ApiOperation({ summary: "Criar um cadastro (sem pedido do funcionário): fica em rascunho para o RH preencher" })
  @ApiBody({ schema: openApi(createBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>) {
    return unwrap(await this.employees.create(this.repo(t), new PrismaHrSettingsRepository(t.db), actorOf(u), body), HR_HTTP);
  }

  @Get(":id")
  @RequirePermission("hr.employees.view")
  @ApiOperation({ summary: "Cadastro completo: dados, ficheiros, o que falta e histórico" })
  async detail(@CurrentTenant() t: TenantContext, @Param("id", id) employeeId: string) {
    return { ...unwrap(await this.employees.detail(this.repo(t), employeeId), HR_HTTP), storageReady: this.stores.for(t.entry).ready };
  }

  @Put(":id/steps/:step")
  @RequirePermission("hr.employees.view")
  @ApiOperation({ summary: "Gravar um passo do cadastro (RH)" })
  @ApiBody({ schema: openApi(stepBody) })
  async save(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Param("step", step) key: string, @Body(new ZodValidationPipe(stepBody)) body: z.infer<typeof stepBody>) {
    const { repo, e } = await this.load(t, employeeId);
    return unwrap(await this.employees.saveStep(repo, e, await this.editor(t, u, e), key, body), HR_HTTP);
  }

  @Post(":id/documents")
  @RequirePermission("hr.employees.view")
  @Upload()
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Juntar um ficheiro ao cadastro (RH)" })
  async upload(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @UploadedFile() file: Upload, @Body(new ZodValidationPipe(uploadBody)) body: z.infer<typeof uploadBody>) {
    const { repo, e } = await this.load(t, employeeId);
    return unwrap(await this.employees.upload(repo, this.stores.for(t.entry), e, await this.editor(t, u, e), { ...body, file }), HR_HTTP);
  }

  @Get(":id/documents/:docId")
  @RequirePermission("hr.employees.view")
  @ApiOperation({ summary: "Ver um ficheiro do cadastro (decifrado pela API; nunca há link direto)" })
  async file(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Param("docId", id) docId: string, @Res({ passthrough: true }) res: Response) {
    const { repo, e } = await this.load(t, employeeId);
    const f = unwrap(await this.employees.readFile(this.stores.for(t.entry), e, docId), HR_HTTP);
    await repo.record("HR_EMPLOYEE_FILE_VIEWED", e.id, u.support ? null : u.id, { docId }, new Date());
    return sendFile(res, f);
  }

  @Delete(":id/documents/:docId")
  @RequirePermission("hr.employees.view")
  @ApiOperation({ summary: "Retirar um ficheiro do cadastro (RH)" })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Param("docId", id) docId: string) {
    const { repo, e } = await this.load(t, employeeId);
    return unwrap(await this.employees.removeFile(repo, this.stores.for(t.entry), e, await this.editor(t, u, e), docId), HR_HTTP);
  }

  @Post(":id/submit")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.employees.view")
  @ApiOperation({ summary: "Submeter para aprovação um cadastro preenchido pelo RH" })
  @ApiBody({ schema: openApi(revisionBody) })
  async submit(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(revisionBody)) body: z.infer<typeof revisionBody>) {
    const { repo, e } = await this.load(t, employeeId);
    return unwrap(await this.employees.submit(repo, this.stores.for(t.entry), e, await this.editor(t, u, e), school(t), body), HR_HTTP);
  }

  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.employees.approve")
  @ApiOperation({ summary: "Aprovar o cadastro (atribui o n.º de funcionário; NÃO ativa o vínculo)" })
  @ApiBody({ schema: openApi(approveBody) })
  async approve(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(approveBody)) body: z.infer<typeof approveBody>) {
    return unwrap(await this.employees.approve(this.repo(t), school(t), actorOf(u), employeeId, body), HR_HTTP);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.employees.reject")
  @ApiOperation({ summary: "Rejeitar o cadastro (justificação obrigatória; notify = mostrá-la no email)" })
  @ApiBody({ schema: openApi(reasonBody) })
  async reject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    return unwrap(await this.employees.reject(this.repo(t), school(t), actorOf(u), employeeId, body), HR_HTTP);
  }

  @Post(":id/request-correction")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.employees.approve")
  @ApiOperation({ summary: "Pedir correções (o funcionário recebe um novo link com a nota do RH)" })
  @ApiBody({ schema: openApi(reasonBody) })
  async correction(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    return unwrap(await this.employees.requestCorrection(this.repo(t), new PrismaRegistrationRepository(t.db), school(t), actorOf(u), employeeId, body), HR_HTTP);
  }

  @Post(":id/employment")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.employees.edit")
  @ApiOperation({ summary: "Vínculo: ativar, suspender ou desligar (suspender e desligar com justificação)" })
  @ApiBody({ schema: openApi(employmentBody) })
  async employment(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(employmentBody)) body: z.infer<typeof employmentBody>) {
    return unwrap(await this.employees.setEmployment(this.repo(t), actorOf(u), employeeId, body), HR_HTTP);
  }

  @Patch(":id/admin")
  @RequirePermission("hr.employees.edit")
  @ApiOperation({ summary: "Cargo e departamento (o que aparece na lista e na ficha)" })
  @ApiBody({ schema: openApi(adminBody) })
  async admin(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(adminBody)) body: z.infer<typeof adminBody>) {
    return unwrap(await this.employees.updateAdmin(this.repo(t), actorOf(u), employeeId, body), HR_HTTP);
  }
}
