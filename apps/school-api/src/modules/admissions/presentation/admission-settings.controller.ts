import { Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { AdmissionSettings } from "../application/AdmissionSettings";
import type { AdmissionErrorCode } from "../domain/settings";
import { PrismaAdmissionSettingsRepository } from "../infrastructure/prisma-admission-settings";

export const ADMISSIONS_HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  YEAR_NOT_FOUND: HttpStatus.NOT_FOUND,
  YEAR_CLOSED: HttpStatus.CONFLICT,
  DOCUMENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  DOCUMENT_EXISTS: HttpStatus.CONFLICT,
  LIMIT_REACHED: HttpStatus.CONFLICT,
  FORBIDDEN: HttpStatus.FORBIDDEN,
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
  constructor(private readonly settings: AdmissionSettings) {}

  private repo(t: TenantContext) {
    return new PrismaAdmissionSettingsRepository(t.db);
  }

  @Get()
  @RequirePermission("admissions.access")
  @ApiOperation({ summary: "Configuração: anos letivos com os períodos (e o estado de cada um hoje), documentos, sugestões e catálogos" })
  async view(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    const p = await permissionsOf(t.db, u);
    return this.settings.view(this.repo(t), { manageSettings: p.includes("admissions.settings.manage"), manageDocuments: p.includes("admissions.documents.manage") });
  }

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
