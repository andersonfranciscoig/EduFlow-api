import { Body, Controller, Delete, Get, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { ApplicationReview } from "../application/ApplicationReview";
import { Applications } from "../application/Applications";
import type { AdmissionErrorCode } from "../domain/settings";
import { PrismaAdmissionFormsRepository } from "../infrastructure/prisma-admission-forms";
import { PrismaApplicationsRepository } from "../infrastructure/prisma-applications";

export const APPLICATIONS_HTTP: Partial<Record<AdmissionErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  APPLICATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  FILE_NOT_FOUND: HttpStatus.NOT_FOUND,
  VERSION_NOT_FOUND: HttpStatus.NOT_FOUND,
  APPLICATIONS_CLOSED: HttpStatus.CONFLICT,
  NOT_EDITABLE: HttpStatus.CONFLICT,
  STALE: HttpStatus.CONFLICT,
  DUPLICATE_APPLICATION: HttpStatus.CONFLICT,
  INCOMPLETE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_FILE: HttpStatus.UNPROCESSABLE_ENTITY,
  STORAGE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

const id = new ParseUUIDPipe({ version: "4" });
const startBody = z.object({ processType: z.string().max(20) }).meta({ title: "ApplicationStart" });
const saveBody = z
  .object({ step: z.string().max(20), version: z.number().int().min(1), advance: z.boolean().optional(), data: z.record(z.string(), z.unknown()).optional() })
  .meta({ title: "ApplicationSave", description: "Grava um passo (mesmo incompleto); devolve os erros do passo. advance=true marca o passo seguinte como atual quando não há erros." });
const submitBody = z.object({ version: z.number().int().min(1), acceptTerms: z.boolean(), legitimacy: z.boolean().optional() }).meta({ title: "ApplicationSubmit" });
const fileBody = z.object({ slot: z.enum(["PHOTO", "DOCUMENT", "FIELD"]), itemId: z.string().max(64).optional() });

type Upload = { originalname: string; buffer: Buffer } | undefined;
const school = (t: TenantContext) => ({ name: t.entry.schoolName, slug: t.entry.slug });

const listQuery = z.object({ year: z.uuid().optional(), class: z.uuid().optional(), status: z.string().max(30).optional(), q: z.string().max(80).optional(), page: z.coerce.number().int().min(1).max(10_000).optional() });
const decisionBody = z
  .object({ reason: z.string().max(1000).nullish(), notes: z.string().max(1000).nullish(), steps: z.array(z.string().max(20)).max(10).optional() })
  .meta({ title: "ApplicationDecision", description: "reason: obrigatório para pedir correções e rejeitar · steps: os passos a corrigir (pedir correções) · notes: observações internas." });

/**
 * Secretaria · análise das inscrições. Ver: admissions.applications.view · decidir:
 * admissions.applications.review. Nunca para professores (nem para o suporte: dados pessoais).
 */
@ApiTags("Portal · Secretaria · Inscrições")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/admissions/applications")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class StaffApplicationsController {
  constructor(
    private readonly review: ApplicationReview,
    private readonly stores: HrFileStores,
  ) {}

  private repo = (t: TenantContext) => new PrismaApplicationsRepository(t.db);

  @Get()
  @RequirePermission("admissions.applications.view")
  @ApiOperation({ summary: "Inscrições submetidas, com filtros (ano, classe, estado, pesquisa) e o n.º por estado" })
  list(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.review.list(this.repo(t), { yearId: q.year, classId: q.class, status: q.status, q: q.q, page: q.page });
  }

  @Get(":id")
  @RequirePermission("admissions.applications.view")
  @ApiOperation({ summary: "Uma inscrição: dados, documentos, quem a fez, histórico e as ações possíveis" })
  async get(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) appId: string) {
    const canReview = (await permissionsOf(t.db, u)).includes("admissions.applications.review");
    return unwrap(await this.review.get(this.repo(t), new PrismaAdmissionFormsRepository(t.db), appId, canReview), APPLICATIONS_HTTP);
  }

  @Get(":id/files/:fileId")
  @RequirePermission("admissions.applications.view")
  @ApiOperation({ summary: "Ver um ficheiro da inscrição (decifrado pela API)" })
  async file(@CurrentTenant() t: TenantContext, @Param("id", id) appId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    const f = unwrap(await this.review.readFile(this.repo(t), this.stores.for(t.entry), appId, fileId), APPLICATIONS_HTTP);
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(f.content);
  }

  @Post(":id/:action")
  @RequirePermission("admissions.applications.review")
  @ApiOperation({ summary: "Decidir: review (começar a análise) · corrections (pedir correções) · approve · reject" })
  @ApiBody({ schema: openApi(decisionBody) })
  async decide(
    @CurrentTenant() t: TenantContext,
    @CurrentUser() u: SchoolAccess,
    @Param("id", id) appId: string,
    @Param("action", new ZodValidationPipe(z.enum(["review", "corrections", "approve", "reject"], { error: "Ação inválida." }))) action: "review" | "corrections" | "approve" | "reject",
    @Body(new ZodValidationPipe(decisionBody)) body: z.infer<typeof decisionBody>,
  ) {
    return unwrap(await this.review.decide(this.repo(t), { id: u.id, name: u.fullName }, school(t), appId, action, body), APPLICATIONS_HTTP);
  }
}

/** Página pública de inscrição: os períodos abertos (sem sessão). */
@ApiTags("Inscrições · público")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/admissions/public")
@UseGuards(TenantGuard)
export class PublicAdmissionsController {
  constructor(private readonly applications: Applications) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "Anos letivos com as inscrições abertas hoje e os tipos de inscrição online" })
  info(@CurrentTenant() t: TenantContext) {
    return this.applications.publicInfo(new PrismaApplicationsRepository(t.db));
  }
}

/** Área da família · inscrições (a conta só vê e altera as suas). */
@ApiTags("Área da família · Inscrições")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family/applications")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyApplicationsController {
  constructor(
    private readonly applications: Applications,
    private readonly stores: HrFileStores,
  ) {}

  private repo = (t: TenantContext) => new PrismaApplicationsRepository(t.db);
  private forms = (t: TenantContext) => new PrismaAdmissionFormsRepository(t.db);

  @Get()
  @ApiOperation({ summary: "As minhas inscrições (e se as inscrições estão abertas)" })
  list(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.applications.list(this.repo(t), f.account);
  }

  @Post()
  @ApiOperation({ summary: "Começar uma inscrição (rascunho preso à última versão publicada do formulário)" })
  @ApiBody({ schema: openApi(startBody) })
  async start(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(startBody)) body: z.infer<typeof startBody>) {
    return unwrap(await this.applications.start(this.repo(t), this.forms(t), f.account, body.processType), APPLICATIONS_HTTP);
  }

  @Get(":id")
  @ApiOperation({ summary: "Uma inscrição: dados, formulário da versão, ficheiros, opções e o que falta por passo" })
  async get(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string) {
    return unwrap(await this.applications.get(this.repo(t), this.forms(t), f.account, appId), APPLICATIONS_HTTP);
  }

  @Put(":id")
  @ApiOperation({ summary: "Gravar um passo (gravação automática; 409 se foi alterada noutra janela)" })
  @ApiBody({ schema: openApi(saveBody) })
  async save(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string, @Body(new ZodValidationPipe(saveBody)) body: z.infer<typeof saveBody>) {
    return unwrap(await this.applications.save(this.repo(t), this.forms(t), f.account, appId, body), APPLICATIONS_HTTP);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Apagar um rascunho (e os ficheiros)" })
  async discard(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string) {
    return unwrap(await this.applications.discard(this.repo(t), this.stores.for(t.entry), f.account, appId), APPLICATIONS_HTTP);
  }

  @Post(":id/files")
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 4 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Entregar um ficheiro (fotografia, documento ou campo de ficheiro); cifrado; formato confirmado pelos bytes" })
  async upload(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string, @Body(new ZodValidationPipe(fileBody)) body: z.infer<typeof fileBody>, @UploadedFile() file: Upload) {
    return unwrap(await this.applications.upload(this.repo(t), this.forms(t), this.stores.for(t.entry), f.account, appId, body, file), APPLICATIONS_HTTP);
  }

  @Get(":id/files/:fileId")
  @ApiOperation({ summary: "Ver um ficheiro (decifrado pela API; nunca há link direto)" })
  async read(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    const file = unwrap(await this.applications.readFile(this.repo(t), this.stores.for(t.entry), f.account, appId, fileId), APPLICATIONS_HTTP);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // os bytes do ficheiro (um Buffer devolvido "solto" seria serializado como JSON)
    return new StreamableFile(file.content);
  }

  @Delete(":id/files/:fileId")
  @ApiOperation({ summary: "Retirar um ficheiro (só antes de submeter)" })
  async removeFile(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string, @Param("fileId", id) fileId: string) {
    return unwrap(await this.applications.removeFile(this.repo(t), this.stores.for(t.entry), f.account, appId, fileId), APPLICATIONS_HTTP);
  }

  @Post(":id/submit")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Submeter: valida tudo, cria o aluno (Candidato) e a relação com o encarregado, dá o n.º do processo e avisa por email" })
  @ApiBody({ schema: openApi(submitBody) })
  async submit(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) appId: string, @Body(new ZodValidationPipe(submitBody)) body: z.infer<typeof submitBody>) {
    return unwrap(await this.applications.submit(this.repo(t), this.forms(t), f.account, school(t), appId, body), APPLICATIONS_HTTP);
  }
}
