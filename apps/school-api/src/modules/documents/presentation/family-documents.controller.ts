import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import { DocumentIssuing } from "../application/DocumentIssuing";
import { ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { DocumentRequests, type Notices } from "../application/DocumentRequests";
import type { RequestStatus } from "../domain/documents";
import { PrismaDocumentsRepository } from "../infrastructure/prisma-documents";
import { attachBody, CREATE_FILES, cancelBody, createInput, documentNotices, DOCUMENTS_HTTP, type MultiFile, requestBody, sendDocument } from "./documents.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const familyRequestBody = requestBody.extend({ studentId: z.uuid() }).meta({ title: "FamilyDocumentRequest", description: "O aluno (o próprio, ou um educando menor que a conta gere), o documento e as respostas." });
const listQuery = new ZodValidationPipe(
  z.object({
    aluno: z.uuid().optional(),
    estado: z.enum(["PENDING", "IN_REVIEW", "AWAITING_PAYMENT", "PROCESSING", "READY_PICKUP", "READY_DOWNLOAD", "COMPLETED", "REJECTED", "CANCELLED", "OPEN"]).optional(),
    q: z.string().max(120).optional(),
    pagina: z.coerce.number().int().min(1).max(1000).optional(),
  }),
);

/**
 * Família · documentos: o aluno maior pede os seus; o encarregado, os dos educandos menores que gere.
 * Quem pode representar cada aluno confirma-se aqui (nunca se confia no aluno que vem do portal).
 */
@ApiTags("Família · Documentos")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/family/documents")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyDocumentsController {
  constructor(
    private readonly requests: DocumentRequests,
    private readonly issuing: DocumentIssuing,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaDocumentsRepository.for(t.db);
  }
  private notices(t: TenantContext): Notices {
    return documentNotices(this.notifier, t);
  }

  @Get("catalog")
  @ApiOperation({ summary: "Os documentos que se podem pedir e os alunos da conta (o próprio e os educandos menores que gere)" })
  async catalog(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.requests.familyCatalog(this.repo(t), f.account.id);
  }

  @Post("requests")
  @UseInterceptors(CREATE_FILES)
  @ApiOperation({ summary: "Pedir um documento para um aluno da conta (JSON, ou multipart com payload + anexo.<documento> para os documentos a juntar)" })
  @ApiBody({ schema: openApi(familyRequestBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body() raw: unknown, @UploadedFiles() files: MultiFile[] | undefined) {
    const { body, uploads } = createInput(familyRequestBody, raw, files, this.stores.for(t.entry));
    return unwrap(await this.requests.familyCreate(this.repo(t), this.notices(t), f.account.id, body, uploads), DOCUMENTS_HTTP);
  }

  @Post("requests/:id/attachments")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 + 1, files: 1, fields: 1 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Juntar um documento ao pedido (campos file e itemKey), enquanto o colégio o está a tratar" })
  async attach(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(attachBody)) body: z.infer<typeof attachBody>, @UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer } | undefined) {
    return unwrap(await this.requests.addAttachment(this.repo(t), this.stores.for(t.entry), this.notices(t), { kind: "FAMILY", accountId: f.account.id }, requestId, body.itemKey, file), DOCUMENTS_HTTP);
  }

  @Get("requests/:id/attachments/:fileId")
  @ApiOperation({ summary: "Abrir um documento junto ao pedido" })
  async attachment(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.requests.attachmentFile(this.repo(t), this.stores.for(t.entry), { kind: "FAMILY", accountId: f.account.id }, requestId, fileId), DOCUMENTS_HTTP));
  }

  @Get("requests")
  @ApiOperation({ summary: "Os pedidos dos alunos da conta (?aluno=&estado=&q=&pagina=)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Query(listQuery) q: { aluno?: string; estado?: RequestStatus | "OPEN"; q?: string; pagina?: number }) {
    return this.requests.familyList(this.repo(t), this.notices(t), f.account.id, { studentId: q.aluno, status: q.estado, q: q.q, page: q.pagina });
  }

  @Get("requests/:id")
  @ApiOperation({ summary: "Um pedido, com o histórico (sem as notas internas do colégio)" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string) {
    return unwrap(await this.requests.familyDetail(this.repo(t), this.notices(t), f.account.id, requestId), DOCUMENTS_HTTP);
  }

  @Get("requests/:id/file")
  @ApiOperation({ summary: "Descarregar o documento (quando está pronto e, com taxa paga até à entrega, depois de pago); fica no histórico" })
  async file(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.issuing.requesterFile(this.repo(t), this.stores.for(t.entry), this.notices(t), { kind: "FAMILY", accountId: f.account.id }, requestId), DOCUMENTS_HTTP), true);
  }

  @Post("requests/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancelar um pedido (enquanto o colégio ainda não o começou a preparar)" })
  @ApiBody({ schema: openApi(cancelBody) })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(cancelBody)) body: z.infer<typeof cancelBody>) {
    return unwrap(await this.requests.familyCancel(this.repo(t), this.notices(t), f.account.id, requestId, body.reason ?? null), DOCUMENTS_HTTP);
  }
}
