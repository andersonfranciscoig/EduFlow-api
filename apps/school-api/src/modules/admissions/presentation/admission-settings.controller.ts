import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { AdmissionForms } from "../application/AdmissionForms";
import { AdmissionSettings } from "../application/AdmissionSettings";
import { type AdmissionErrorCode, admissionError } from "../domain/settings";
import { PrismaAdmissionFormsRepository } from "../infrastructure/prisma-admission-forms";
import { PrismaAdmissionSettingsRepository } from "../infrastructure/prisma-admission-settings";

export const ADMISSIONS_HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  YEAR_NOT_FOUND: HttpStatus.NOT_FOUND,
  YEAR_CLOSED: HttpStatus.CONFLICT,
  DOCUMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  DOCUMENT_EXISTS: HttpStatus.CONFLICT,
  LIMIT_REACHED: HttpStatus.CONFLICT,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  SECTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  FIELD_NOT_FOUND: HttpStatus.NOT_FOUND,
  FIELD_IN_USE: HttpStatus.CONFLICT,
  NOTHING_TO_PUBLISH: HttpStatus.CONFLICT,
  VERSION_NOT_FOUND: HttpStatus.NOT_FOUND,
};

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const window = z.object({ from: isoDay, to: isoDay }).nullable();
const periodsBody = z
  .object({ applications: window, enrollments: window, renewals: window })
  .meta({ title: "AdmissionPeriods", description: "Inscrições, matrículas e renovações do ano letivo: { from, to } ou null (fechado / por definir)." });
const documentBody = z
  .object({
    name: z.string().max(80),
    description: z.string().max(240).nullish(),
    required: z.boolean(),
    target: z.enum(["STUDENT", "GUARDIAN", "BOTH"]),
    processTypes: z.array(z.enum(["NOVA", "RENOVACAO", "TRANSFERENCIA", "REINGRESSO"])).max(4).default([]),
    formats: z.array(z.enum(["pdf", "jpg", "png", "webp", "doc", "docx"])).min(1).max(6),
    maxSizeMb: z.number().int().min(1).max(20),
    maxFiles: z.number().int().min(1).max(10),
    needsExpiry: z.boolean().default(false),
  })
  .meta({ title: "AdmissionDocumentType", description: "Documento pedido: a quem (aluno, encarregado ou ambos), em que processos (vazio = todos), formatos, tamanho (MB), n.º de ficheiros e se se pede a validade." });
const activeBody = z.object({ active: z.boolean() });
const orderBody = z.object({ ids: z.array(z.uuid()).max(100) });
const namesBody = z.object({ names: z.array(z.string().max(80)).min(1).max(30) });
const keysBody = z.object({ keys: z.array(z.string().max(40)).min(1).max(10) });
const processes = z.array(z.enum(["NOVA", "RENOVACAO", "TRANSFERENCIA", "REINGRESSO"])).max(4).default([]);
const modeBody = z.object({ mode: z.enum(["REQUIRED", "OPTIONAL", "HIDDEN"]) }).meta({ title: "AdmissionFixedMode" });
const sectionBody = z
  .object({
    title: z.string().max(60),
    description: z.string().max(240).nullish(),
    repeatable: z.boolean().default(false),
    entryLabel: z.string().max(40).nullish(),
    maxEntries: z.number().int().min(1).max(20).optional(),
    processTypes: processes,
  })
  .meta({ title: "AdmissionFormSection", description: "Secção do colégio: repetível (com o nome e o limite de registos) e em que processos aparece (vazio = todos)." });
const fieldBody = z
  .object({
    label: z.string().max(80),
    type: z.enum(["TEXT", "LONG_TEXT", "NUMBER", "DATE", "EMAIL", "PHONE", "SELECT", "MULTI_SELECT", "BOOLEAN", "FILE"]),
    required: z.boolean().default(false),
    help: z.string().max(240).nullish(),
    options: z.array(z.string().max(80)).max(40).nullish(),
    settings: z
      .object({ formats: z.array(z.enum(["pdf", "jpg", "png", "webp", "doc", "docx"])).max(6).optional(), maxSizeMb: z.number().int().optional(), min: z.number().nullish(), max: z.number().nullish() })
      .nullish(),
    processTypes: processes,
    condition: z.object({ fieldId: z.uuid(), values: z.array(z.string().max(80)).min(1).max(40) }).nullish(),
  })
  .meta({ title: "AdmissionFormField", description: "Campo: tipo, obrigatório, instrução, opções (escolhas), regras (ficheiro/número), processos e condição { fieldId, values }." });

const actorOf = (u: SchoolAccess) => (u.support ? null : u.id);

/**
 * Secretaria · configuração das inscrições e matrículas (1.ª parte): períodos de cada ano letivo e
 * documentos pedidos. Ver: admissions.access · períodos: admissions.settings.manage ·
 * documentos: admissions.documents.manage. Nunca para professores.
 */
@ApiTags("Portal · Secretaria · Configuração das inscrições")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/admissions/settings")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class AdmissionSettingsController {
  constructor(
    private readonly settings: AdmissionSettings,
    private readonly forms: AdmissionForms,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaAdmissionSettingsRepository(t.db);
  }

  private formsRepo(t: TenantContext) {
    return new PrismaAdmissionFormsRepository(t.db);
  }

  @Get()
  @RequirePermission("admissions.access")
  @ApiOperation({ summary: "Configuração: períodos (com o estado de hoje), documentos, formulários (dados fixos, secções, campos), versões e o que está por publicar" })
  async view(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    const p = await permissionsOf(t.db, u);
    const [settings, forms] = await Promise.all([
      this.settings.view(this.repo(t), { manageSettings: p.includes("admissions.settings.manage"), manageDocuments: p.includes("admissions.documents.manage") }),
      this.forms.view(this.formsRepo(t), { manageForms: p.includes("admissions.forms.manage"), publish: p.includes("admissions.forms.manage") || p.includes("admissions.documents.manage") }),
    ]);
    return { ...settings, forms };
  }

  // ---------------------------------------------------------------- formulários

  @Put("fixed/:scope/:key")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Modo de um dado fixo do aluno/encarregado (obrigatório, opcional, não pedir)", description: "Os campos essenciais não mudam (422)." })
  @ApiBody({ schema: openApi(modeBody) })
  async fixedMode(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("scope") scope: string, @Param("key") key: string, @Body(new ZodValidationPipe(modeBody)) body: z.infer<typeof modeBody>) {
    return unwrap(await this.forms.setFixedMode(this.formsRepo(t), actorOf(u), { scope, key, mode: body.mode }), ADMISSIONS_HTTP);
  }

  @Post("sections")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Nova secção do formulário" })
  @ApiBody({ schema: openApi(sectionBody) })
  async createSection(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(sectionBody)) body: z.infer<typeof sectionBody>) {
    return unwrap(await this.forms.createSection(this.formsRepo(t), actorOf(u), body), ADMISSIONS_HTTP);
  }

  @Post("sections/suggestions")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Juntar secções sugeridas (com os campos e as condições)" })
  @ApiBody({ schema: openApi(keysBody) })
  async sectionSuggestions(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(keysBody)) body: z.infer<typeof keysBody>) {
    return unwrap(await this.forms.addSuggestedSections(this.formsRepo(t), actorOf(u), body.keys), ADMISSIONS_HTTP);
  }

  @Put("sections/order")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Ordem das secções" })
  @ApiBody({ schema: openApi(orderBody) })
  async sectionOrder(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return unwrap(await this.forms.reorderSections(this.formsRepo(t), body.ids), ADMISSIONS_HTTP);
  }

  @Patch("sections/:id")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Alterar secção" })
  @ApiBody({ schema: openApi(sectionBody) })
  async updateSection(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) sectionId: string, @Body(new ZodValidationPipe(sectionBody)) body: z.infer<typeof sectionBody>) {
    return unwrap(await this.forms.updateSection(this.formsRepo(t), actorOf(u), sectionId, body), ADMISSIONS_HTTP);
  }

  @Post("sections/:id/active")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Ativar ou desativar uma secção" })
  @ApiBody({ schema: openApi(activeBody) })
  async sectionActive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) sectionId: string, @Body(new ZodValidationPipe(activeBody)) body: z.infer<typeof activeBody>) {
    return unwrap(await this.forms.setSectionActive(this.formsRepo(t), actorOf(u), sectionId, body.active), ADMISSIONS_HTTP);
  }

  @Delete("sections/:id")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Eliminar secção (e os seus campos; as versões publicadas mantêm-nos)" })
  async deleteSection(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) sectionId: string) {
    return unwrap(await this.forms.deleteSection(this.formsRepo(t), actorOf(u), sectionId), ADMISSIONS_HTTP);
  }

  @Post("sections/:id/fields")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Novo campo (fica no fim da secção)", description: "A condição usa um campo anterior da mesma secção (escolha, escolha múltipla ou sim/não)." })
  @ApiBody({ schema: openApi(fieldBody) })
  async createField(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) sectionId: string, @Body(new ZodValidationPipe(fieldBody)) body: z.infer<typeof fieldBody>) {
    return unwrap(await this.forms.createField(this.formsRepo(t), actorOf(u), sectionId, body), ADMISSIONS_HTTP);
  }

  @Put("sections/:id/fields/order")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Ordem dos campos da secção", description: "409 FIELD_IN_USE se um campo ficar antes do campo de que depende." })
  @ApiBody({ schema: openApi(orderBody) })
  async fieldOrder(@CurrentTenant() t: TenantContext, @Param("id", id) sectionId: string, @Body(new ZodValidationPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return unwrap(await this.forms.reorderFields(this.formsRepo(t), sectionId, body.ids), ADMISSIONS_HTTP);
  }

  @Patch("fields/:id")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Alterar campo", description: "409 FIELD_IN_USE se partir a condição de outro campo." })
  @ApiBody({ schema: openApi(fieldBody) })
  async updateField(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) fieldId: string, @Body(new ZodValidationPipe(fieldBody)) body: z.infer<typeof fieldBody>) {
    return unwrap(await this.forms.updateField(this.formsRepo(t), actorOf(u), fieldId, body), ADMISSIONS_HTTP);
  }

  @Post("fields/:id/active")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Ativar ou desativar um campo" })
  @ApiBody({ schema: openApi(activeBody) })
  async fieldActive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) fieldId: string, @Body(new ZodValidationPipe(activeBody)) body: z.infer<typeof activeBody>) {
    return unwrap(await this.forms.setFieldActive(this.formsRepo(t), actorOf(u), fieldId, body.active), ADMISSIONS_HTTP);
  }

  @Delete("fields/:id")
  @RequirePermission("admissions.forms.manage")
  @ApiOperation({ summary: "Eliminar campo", description: "409 FIELD_IN_USE se outro campo depende dele." })
  async deleteField(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) fieldId: string) {
    return unwrap(await this.forms.deleteField(this.formsRepo(t), actorOf(u), fieldId), ADMISSIONS_HTTP);
  }

  @Post("publish")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("admissions.access")
  @ApiOperation({ summary: "Publicar uma nova versão (dados fixos, secções e documentos)", description: "Quem configura formulários ou documentos. 409 NOTHING_TO_PUBLISH sem alterações." })
  async publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    const p = await permissionsOf(t.db, u);
    if (!p.includes("admissions.forms.manage") && !p.includes("admissions.documents.manage")) {
      return unwrap({ ok: false, error: admissionError("FORBIDDEN", "Não tem permissão para publicar os formulários.") }, ADMISSIONS_HTTP);
    }
    return unwrap(await this.forms.publish(this.formsRepo(t), actorOf(u)), ADMISSIONS_HTTP);
  }

  @Get("versions/:number")
  @RequirePermission("admissions.access")
  @ApiOperation({ summary: "Uma versão publicada (fotografia completa)" })
  async version(@CurrentTenant() t: TenantContext, @Param("number", new ZodValidationPipe(z.coerce.number().int().min(1))) number: number) {
    return unwrap(await this.forms.version(this.formsRepo(t), number), ADMISSIONS_HTTP);
  }

  // ---------------------------------------------------------------- períodos e documentos

  @Put("years/:yearId/periods")
  @RequirePermission("admissions.settings.manage")
  @ApiOperation({ summary: "Períodos de inscrição, matrícula e renovação do ano letivo", description: "Abrem até um ano antes do início do ano letivo e fecham até ao fim dele." })
  @ApiBody({ schema: openApi(periodsBody) })
  async periods(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("yearId", id) yearId: string, @Body(new ZodValidationPipe(periodsBody)) body: z.infer<typeof periodsBody>) {
    return unwrap(await this.settings.savePeriods(this.repo(t), actorOf(u), yearId, body), ADMISSIONS_HTTP);
  }

  @Post("documents")
  @RequirePermission("admissions.documents.manage")
  @ApiOperation({ summary: "Novo documento pedido" })
  @ApiBody({ schema: openApi(documentBody) })
  async createDocument(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(documentBody)) body: z.infer<typeof documentBody>) {
    return unwrap(await this.settings.createDocument(this.repo(t), actorOf(u), body), ADMISSIONS_HTTP);
  }

  @Post("documents/suggestions")
  @RequirePermission("admissions.documents.manage")
  @ApiOperation({ summary: "Juntar documentos sugeridos (pelo nome)" })
  @ApiBody({ schema: openApi(namesBody) })
  async suggestions(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(namesBody)) body: z.infer<typeof namesBody>) {
    return unwrap(await this.settings.addSuggestedDocuments(this.repo(t), actorOf(u), body.names), ADMISSIONS_HTTP);
  }

  @Put("documents/order")
  @RequirePermission("admissions.documents.manage")
  @ApiOperation({ summary: "Ordem dos documentos" })
  @ApiBody({ schema: openApi(orderBody) })
  async order(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return unwrap(await this.settings.reorderDocuments(this.repo(t), body.ids), ADMISSIONS_HTTP);
  }

  @Patch("documents/:id")
  @RequirePermission("admissions.documents.manage")
  @ApiOperation({ summary: "Alterar documento" })
  @ApiBody({ schema: openApi(documentBody) })
  async updateDocument(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) docId: string, @Body(new ZodValidationPipe(documentBody)) body: z.infer<typeof documentBody>) {
    return unwrap(await this.settings.updateDocument(this.repo(t), actorOf(u), docId, body), ADMISSIONS_HTTP);
  }

  @Post("documents/:id/active")
  @RequirePermission("admissions.documents.manage")
  @ApiOperation({ summary: "Ativar ou desativar um documento" })
  @ApiBody({ schema: openApi(activeBody) })
  async active(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) docId: string, @Body(new ZodValidationPipe(activeBody)) body: z.infer<typeof activeBody>) {
    return unwrap(await this.settings.setDocumentActive(this.repo(t), actorOf(u), docId, body.active), ADMISSIONS_HTTP);
  }

  @Delete("documents/:id")
  @RequirePermission("admissions.documents.manage")
  @ApiOperation({ summary: "Eliminar documento" })
  async deleteDocument(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) docId: string) {
    return unwrap(await this.settings.deleteDocument(this.repo(t), actorOf(u), docId), ADMISSIONS_HTTP);
  }
}
