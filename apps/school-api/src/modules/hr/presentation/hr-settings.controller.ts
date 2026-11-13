import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { HrSettings } from "../application/HrSettings";
import type { HrErrorCode } from "../domain/form";
import { PrismaHrSettingsRepository } from "../infrastructure/prisma-hr-settings";

export const HR_HTTP: Partial<Record<HrErrorCode, HttpStatus>> = {
  FORBIDDEN: HttpStatus.FORBIDDEN,
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  SECTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  FIELD_NOT_FOUND: HttpStatus.NOT_FOUND,
  FIELD_EXISTS: HttpStatus.CONFLICT,
  DOCUMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  DOCUMENT_EXISTS: HttpStatus.CONFLICT,
  LIMIT_REACHED: HttpStatus.CONFLICT,
  NOTHING_TO_PUBLISH: HttpStatus.CONFLICT,
  EMPLOYEE_TYPE_NOT_FOUND: HttpStatus.NOT_FOUND,
  EMPLOYEE_TYPE_EXISTS: HttpStatus.CONFLICT,
  EMPLOYEE_TYPE_IN_USE: HttpStatus.CONFLICT,
  VERSION_NOT_FOUND: HttpStatus.NOT_FOUND,
  REQUEST_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  FORM_NOT_PUBLISHED: HttpStatus.CONFLICT,
  EMAIL_NOT_SENT: HttpStatus.BAD_GATEWAY,
};

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const sectionPipe = new ZodValidationPipe(z.enum(["ACADEMIC", "PROFESSIONAL"], { error: "Secção inválida." }));
const types = ["TEXT", "LONG_TEXT", "NUMBER", "DATE", "EMAIL", "PHONE", "SELECT", "MULTI_SELECT", "BOOLEAN", "FILE"] as const;
const formats = z.array(z.enum(["pdf", "jpg", "png", "webp", "doc", "docx"])).min(1).max(6);

const sectionBody = z
  .object({ title: z.string().min(2).max(60), description: z.string().max(240).nullish(), repeatable: z.boolean(), entryLabel: z.string().min(2).max(40), maxEntries: z.number().int().min(1).max(20) })
  .meta({ title: "HrSection", description: "Título, descrição e se o funcionário pode juntar vários registos (ex.: várias formações)." });
const fieldBody = z
  .object({
    label: z.string().min(2).max(80),
    type: z.enum(types, { error: "Tipo de campo inválido." }),
    required: z.boolean().default(false),
    help: z.string().max(240).nullish(),
    options: z.array(z.string().max(80)).max(40).nullish(),
    settings: z.object({ formats: formats.optional(), maxSizeMb: z.number().int().min(1).max(20).optional(), min: z.number().nullish(), max: z.number().nullish() }).nullish(),
    employeeTypeIds: z.array(z.uuid()).max(20).nullish(),
  })
  .meta({
    title: "HrField",
    description: "Campo de uma secção: nome, tipo, obrigatório, instrução, opções (escolhas), regras (ficheiro: formatos e tamanho; número: mínimo e máximo) e tipos de funcionário a que se aplica (vazio = todos).",
  });
const documentBody = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(240).nullish(),
    required: z.boolean().default(false),
    formats,
    maxSizeMb: z.number().int().min(1).max(20),
    multiple: z.boolean().default(false),
    employeeTypeIds: z.array(z.uuid()).max(20).nullish(),
  })
  .meta({ title: "HrDocumentType", description: "Documento pedido: formatos permitidos, tamanho máximo (MB), se aceita vários ficheiros e a que tipos de funcionário se aplica (vazio = todos)." });
const typeBody = z.object({ name: z.string().min(2).max(60), description: z.string().max(240).nullish() }).meta({ title: "HrEmployeeType", description: "Tipo de funcionário (ex.: Docente)." });
const printQuery = z.object({ version: z.coerce.number().int().min(1).optional(), type: z.uuid().optional() });
const activeBody = z.object({ active: z.boolean() }).meta({ title: "HrActive" });
const orderBody = z.object({ ids: z.array(z.uuid()).max(60) }).meta({ title: "HrOrder", description: "Todos os ids, pela nova ordem." });
const labelsBody = z.object({ labels: z.array(z.string().max(80)).min(1).max(20) }).meta({ title: "HrSuggestions" });

/**
 * Configuração do cadastro de funcionários (Recursos Humanos).
 * Ver: hr.access · campos: hr.settings.manage · documentos: hr.documents.manage · publicar: qualquer uma das duas.
 */
@ApiTags("Portal · Recursos Humanos · Configuração")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/hr/settings")
@UseGuards(TenantGuard, SchoolAuthGuard)
export class HrSettingsController {
  constructor(private readonly settings: HrSettings) {}

  private repo(t: TenantContext) {
    return new PrismaHrSettingsRepository(t.db);
  }

  /** Numa sessão de suporte o id não é de um utilizador do colégio. */
  private actor(u: SchoolAccess) {
    return u.support ? null : u.id;
  }

  private async can(t: TenantContext, u: SchoolAccess) {
    const p = await permissionsOf(t.db, u);
    return { manageForm: p.includes("hr.settings.manage"), manageDocuments: p.includes("hr.documents.manage") };
  }

  @Get()
  @RequirePermission("hr.access")
  @ApiOperation({ summary: "Configuração: dados pessoais (fixos), secções com campos, documentos, versões e o que está por publicar" })
  async view(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.settings.view(this.repo(t), await this.can(t, u));
  }

  // ---------------------------------------------------------------- tipos de funcionário

  @Post("employee-types")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Criar tipo de funcionário" })
  @ApiBody({ schema: openApi(typeBody) })
  async createType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(typeBody)) body: z.infer<typeof typeBody>) {
    return unwrap(await this.settings.createEmployeeType(this.repo(t), this.actor(u), body), HR_HTTP);
  }

  @Post("employee-types/suggestions")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Juntar tipos sugeridos (Docente, Administrativo, Auxiliar)" })
  @ApiBody({ schema: openApi(labelsBody) })
  async addTypeSuggestions(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(labelsBody)) body: z.infer<typeof labelsBody>) {
    return unwrap(await this.settings.addSuggestedEmployeeTypes(this.repo(t), this.actor(u), body.labels), HR_HTTP);
  }

  @Put("employee-types/order")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Ordem dos tipos de funcionário" })
  @ApiBody({ schema: openApi(orderBody) })
  async reorderTypes(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return unwrap(await this.settings.reorderEmployeeTypes(this.repo(t), body.ids), HR_HTTP);
  }

  @Patch("employee-types/:id")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Alterar tipo de funcionário" })
  @ApiBody({ schema: openApi(typeBody) })
  async updateType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string, @Body(new ZodValidationPipe(typeBody)) body: z.infer<typeof typeBody>) {
    return unwrap(await this.settings.updateEmployeeType(this.repo(t), this.actor(u), typeId, body), HR_HTTP);
  }

  @Post("employee-types/:id/active")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Ativar ou desativar tipo de funcionário" })
  @ApiBody({ schema: openApi(activeBody) })
  async setTypeActive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string, @Body(new ZodValidationPipe(activeBody)) body: z.infer<typeof activeBody>) {
    return unwrap(await this.settings.setEmployeeTypeActive(this.repo(t), this.actor(u), typeId, body.active), HR_HTTP);
  }

  @Delete("employee-types/:id")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Eliminar tipo de funcionário (só sem campos/documentos só para ele)", description: "409 EMPLOYEE_TYPE_IN_USE." })
  async deleteType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) typeId: string) {
    return unwrap(await this.settings.deleteEmployeeType(this.repo(t), this.actor(u), typeId), HR_HTTP);
  }

  // ---------------------------------------------------------------- secções e campos

  @Patch("sections/:key")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Alterar uma secção (título, repetível, limite de registos)" })
  @ApiBody({ schema: openApi(sectionBody) })
  async updateSection(@CurrentTenant() t: TenantContext, @Param("key", sectionPipe) key: string, @Body(new ZodValidationPipe(sectionBody)) body: z.infer<typeof sectionBody>) {
    return unwrap(await this.settings.updateSection(this.repo(t), key, body), HR_HTTP);
  }

  @Post("sections/:key/fields")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Criar campo numa secção" })
  @ApiBody({ schema: openApi(fieldBody) })
  async createField(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("key", sectionPipe) key: string, @Body(new ZodValidationPipe(fieldBody)) body: z.infer<typeof fieldBody>) {
    return unwrap(await this.settings.createField(this.repo(t), this.actor(u), key, body), HR_HTTP);
  }

  @Post("sections/:key/suggestions")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Juntar campos sugeridos (pelo nome)" })
  @ApiBody({ schema: openApi(labelsBody) })
  async addSuggestions(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("key", sectionPipe) key: string, @Body(new ZodValidationPipe(labelsBody)) body: z.infer<typeof labelsBody>) {
    return unwrap(await this.settings.addSuggestedFields(this.repo(t), this.actor(u), key, body.labels), HR_HTTP);
  }

  @Put("sections/:key/order")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Ordem dos campos da secção" })
  @ApiBody({ schema: openApi(orderBody) })
  async reorderFields(@CurrentTenant() t: TenantContext, @Param("key", sectionPipe) key: string, @Body(new ZodValidationPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return unwrap(await this.settings.reorderFields(this.repo(t), key, body.ids), HR_HTTP);
  }

  @Patch("fields/:id")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Alterar campo" })
  @ApiBody({ schema: openApi(fieldBody) })
  async updateField(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) fieldId: string, @Body(new ZodValidationPipe(fieldBody)) body: z.infer<typeof fieldBody>) {
    return unwrap(await this.settings.updateField(this.repo(t), this.actor(u), fieldId, body), HR_HTTP);
  }

  @Post("fields/:id/active")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Ativar ou desativar campo" })
  @ApiBody({ schema: openApi(activeBody) })
  async setFieldActive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) fieldId: string, @Body(new ZodValidationPipe(activeBody)) body: z.infer<typeof activeBody>) {
    return unwrap(await this.settings.setFieldActive(this.repo(t), this.actor(u), fieldId, body.active), HR_HTTP);
  }

  @Delete("fields/:id")
  @RequirePermission("hr.settings.manage")
  @ApiOperation({ summary: "Eliminar campo (as versões publicadas guardam a sua cópia)" })
  async deleteField(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) fieldId: string) {
    return unwrap(await this.settings.deleteField(this.repo(t), this.actor(u), fieldId), HR_HTTP);
  }

  // ---------------------------------------------------------------- documentos

  @Post("documents")
  @RequirePermission("hr.documents.manage")
  @ApiOperation({ summary: "Criar tipo de documento" })
  @ApiBody({ schema: openApi(documentBody) })
  async createDocument(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(documentBody)) body: z.infer<typeof documentBody>) {
    return unwrap(await this.settings.createDocument(this.repo(t), this.actor(u), body), HR_HTTP);
  }

  @Post("documents/suggestions")
  @RequirePermission("hr.documents.manage")
  @ApiOperation({ summary: "Juntar documentos sugeridos (pelo nome)" })
  @ApiBody({ schema: openApi(labelsBody) })
  async addDocumentSuggestions(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(labelsBody)) body: z.infer<typeof labelsBody>) {
    return unwrap(await this.settings.addSuggestedDocuments(this.repo(t), this.actor(u), body.labels), HR_HTTP);
  }

  @Put("documents/order")
  @RequirePermission("hr.documents.manage")
  @ApiOperation({ summary: "Ordem dos documentos" })
  @ApiBody({ schema: openApi(orderBody) })
  async reorderDocuments(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(orderBody)) body: z.infer<typeof orderBody>) {
    return unwrap(await this.settings.reorderDocuments(this.repo(t), body.ids), HR_HTTP);
  }

  @Patch("documents/:id")
  @RequirePermission("hr.documents.manage")
  @ApiOperation({ summary: "Alterar tipo de documento" })
  @ApiBody({ schema: openApi(documentBody) })
  async updateDocument(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) docId: string, @Body(new ZodValidationPipe(documentBody)) body: z.infer<typeof documentBody>) {
    return unwrap(await this.settings.updateDocument(this.repo(t), this.actor(u), docId, body), HR_HTTP);
  }

  @Post("documents/:id/active")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.documents.manage")
  @ApiOperation({ summary: "Ativar ou desativar tipo de documento" })
  @ApiBody({ schema: openApi(activeBody) })
  async setDocumentActive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) docId: string, @Body(new ZodValidationPipe(activeBody)) body: z.infer<typeof activeBody>) {
    return unwrap(await this.settings.setDocumentActive(this.repo(t), this.actor(u), docId, body.active), HR_HTTP);
  }

  @Delete("documents/:id")
  @RequirePermission("hr.documents.manage")
  @ApiOperation({ summary: "Eliminar tipo de documento" })
  async deleteDocument(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) docId: string) {
    return unwrap(await this.settings.deleteDocument(this.repo(t), this.actor(u), docId), HR_HTTP);
  }

  // ---------------------------------------------------------------- versões

  @Post("publish")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.access")
  @ApiOperation({ summary: "Publicar a configuração atual como nova versão", description: "Exige hr.settings.manage ou hr.documents.manage. 409 NOTHING_TO_PUBLISH." })
  async publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.settings.publish(this.repo(t), this.actor(u), await this.can(t, u)), HR_HTTP);
  }

  @Get("print")
  @RequirePermission("hr.access")
  @ApiOperation({ summary: "Ficha de inscrição para imprimir (versão publicada, vista por um tipo de funcionário)", description: "?version= (omissão: a última) · ?type= (omissão: todos os campos). 404 VERSION_NOT_FOUND." })
  async print(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(printQuery)) q: z.infer<typeof printQuery>) {
    return unwrap(await this.settings.printableForm(this.repo(t), { version: q.version ?? null, typeId: q.type ?? null }), HR_HTTP);
  }
}
