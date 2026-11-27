import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, UnprocessableEntityException, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { DocumentRequests } from "../application/DocumentRequests";
import type { DocumentsViewer } from "../application/DocumentTypes";
import { StudentCards } from "../application/StudentCards";
import { PrismaCardsRepository } from "../infrastructure/prisma-cards";
import { DOCUMENTS_HTTP, schoolOf, sendDocument } from "./documents.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const settingsBody = z
  .object({
    model: z.enum(["CLASSICO", "MODERNO", "CONTEMPORANEO"]),
    primaryColor: z.string().max(7),
    accentColor: z.string().max(7),
    address: z.string().max(400).nullish(),
    phone: z.string().max(80).nullish(),
    email: z.string().max(200).nullish(),
    showQr: z.boolean(),
    backNote: z.string().max(600).nullish(),
  })
  .meta({ title: "StudentCardSettings", description: "O modelo do cartão (um dos três da plataforma) e a personalização: cores #RRGGBB, contactos, QR e o texto do verso." });
const issueBody = z
  .object({ studentIds: z.array(z.uuid()).min(1).max(300), reason: z.string().max(600).nullish(), yearId: z.uuid().nullish() })
  .meta({ title: "StudentCardIssue", description: "Os alunos (um ou vários) e o ano letivo (o da turma; sem ele, o ano em curso); com motivo, quem já tem cartão válido recebe a segunda via." });
const revokeBody = z.object({ reason: z.string().max(600) }).meta({ title: "StudentCardRevoke", description: "Porque se anula (ex.: cartão perdido)." });
const printQuery = new ZodValidationPipe(z.object({ ids: z.string().max(12_000).optional(), formato: z.enum(["cartao", "folha"]).optional() }));
const layoutOf = (f?: string) => (f === "folha" ? "SHEET" : "CARD");
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;

/**
 * DOCUMENTOS · CARTÕES DE ESTUDANTE — o modelo e a personalização, as turmas e os alunos, as
 * fotografias, emitir (um a um, por turma, segunda via), imprimir (cartão ou folha A4) e anular.
 * Tudo exige "Gerir os cartões de estudante" (documents.cards.manage).
 */
@ApiTags("Portal · Documentos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/documents/cards")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class CardsController {
  constructor(
    private readonly cards: StudentCards,
    private readonly requests: DocumentRequests,
    private readonly stores: HrFileStores,
  ) {}

  private repo(t: TenantContext) {
    return PrismaCardsRepository.for(t.db);
  }
  private async viewer(t: TenantContext, u: SchoolAccess): Promise<DocumentsViewer> {
    return { userId: u.id, support: !!u.support, name: u.fullName ?? "Equipa do colégio", permissions: await permissionsOf(t.db, u) };
  }

  @Get()
  @ApiOperation({ summary: "O modelo escolhido e a personalização, os três modelos, os anos letivos por fechar e as turmas do ano (?ano=; com quantos alunos têm cartão)" })
  async overview(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(z.object({ ano: z.uuid().optional() }))) q: { ano?: string }) {
    return unwrap(await this.cards.overview(this.repo(t), await this.viewer(t, u), q.ano ?? null), DOCUMENTS_HTTP);
  }

  @Put("settings")
  @ApiOperation({ summary: "Guardar o modelo e a personalização (os cartões já emitidos não mudam)" })
  @ApiBody({ schema: openApi(settingsBody) })
  async saveSettings(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(settingsBody)) body: z.infer<typeof settingsBody>) {
    const v = await this.viewer(t, u);
    return unwrap(await this.cards.saveSettings(this.repo(t), v, this.requests.actor(v), body), DOCUMENTS_HTTP);
  }

  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Um cartão de exemplo (frente e verso, PDF) com a configuração enviada, mesmo por guardar" })
  @ApiBody({ schema: openApi(settingsBody) })
  async preview(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(settingsBody)) body: z.infer<typeof settingsBody>, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.cards.preview(this.repo(t), await this.viewer(t, u), body, await schoolOf(t, this.stores.for(t.entry))), DOCUMENTS_HTTP));
  }

  @Get("groups/:id")
  @ApiOperation({ summary: "Os alunos de uma turma: fotografia (se há e se se imprime) e o cartão válido deste ano" })
  async group(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string) {
    return unwrap(await this.cards.group(this.repo(t), await this.viewer(t, u), groupId), DOCUMENTS_HTTP);
  }

  @Get("groups/:id/print")
  @ApiOperation({ summary: "Os cartões válidos da turma num PDF (?formato=cartao|folha)" })
  async groupPrint(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) groupId: string, @Query(printQuery) q: { formato?: string }, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.cards.groupPdf(this.repo(t), this.stores.for(t.entry), await this.viewer(t, u), groupId, layoutOf(q.formato), await schoolOf(t, this.stores.for(t.entry))), DOCUMENTS_HTTP));
  }

  @Get("students/:id")
  @ApiOperation({ summary: "O histórico de cartões de um aluno (versões, segundas vias, anulados)" })
  async history(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string) {
    return unwrap(await this.cards.history(this.repo(t), await this.viewer(t, u), studentId), DOCUMENTS_HTTP);
  }

  @Get("students/:id/photo")
  @ApiOperation({ summary: "A fotografia do aluno usada no cartão (a carregada pela secretaria ou a da inscrição)" })
  async photo(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.cards.photoFile(this.repo(t), this.stores.for(t.entry), await this.viewer(t, u), studentId), DOCUMENTS_HTTP));
  }

  @Post("students/:id/photo")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 0 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Carregar a fotografia do aluno (campo file: JPG ou PNG até 5 MB, tipo real verificado)" })
  async uploadPhoto(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) studentId: string, @UploadedFile() file: Upload) {
    const v = await this.viewer(t, u);
    return unwrap(await this.cards.uploadPhoto(this.repo(t), this.stores.for(t.entry), v, this.requests.actor(v), studentId, file), DOCUMENTS_HTTP);
  }

  @Post("issue")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Emitir cartões (um ou vários alunos; com motivo, segunda via a quem já tem). Quem não pode levar cartão volta na lista, com o motivo" })
  @ApiBody({ schema: openApi(issueBody) })
  async issue(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(issueBody)) body: z.infer<typeof issueBody>) {
    const v = await this.viewer(t, u);
    return unwrap(await this.cards.issue(this.repo(t), this.stores.for(t.entry), v, this.requests.actor(v), body, await schoolOf(t, this.stores.for(t.entry))), DOCUMENTS_HTTP);
  }

  @Get("print")
  @ApiOperation({ summary: "Imprimir cartões (?ids=a,b,c&formato=cartao|folha): do tamanho do cartão ou folhas A4 de 10 com marcas de corte" })
  async print(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(printQuery) q: { ids?: string; formato?: string }, @Res({ passthrough: true }) res: Response) {
    const ids = (q.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.some((x) => !z.uuid().safeParse(x).success)) throw new UnprocessableEntityException({ code: "INVALID_INPUT", message: "Cartões inválidos." });
    return sendDocument(res, unwrap(await this.cards.pdf(this.repo(t), this.stores.for(t.entry), await this.viewer(t, u), ids, layoutOf(q.formato), await schoolOf(t, this.stores.for(t.entry))), DOCUMENTS_HTTP));
  }

  @Post(":id/revoke")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Anular um cartão válido (com o motivo): a verificação passa a dizer que foi anulado" })
  @ApiBody({ schema: openApi(revokeBody) })
  async revoke(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cardId: string, @Body(new ZodValidationPipe(revokeBody)) body: z.infer<typeof revokeBody>) {
    return unwrap(await this.cards.revoke(this.repo(t), await this.viewer(t, u), cardId, body.reason), DOCUMENTS_HTTP);
  }
}

/**
 * Verificar um cartão (página aberta pelo QR ou pelo código impresso). Sem sessão: só diz se é
 * válido, o colégio, o ano letivo e o nome abreviado. Pedidos limitados por IP.
 */
@ApiTags("Público · Cartões de estudante")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/public/cards")
@UseGuards(TenantGuard)
export class PublicCardsController {
  constructor(private readonly cards: StudentCards) {}

  @Get(":code")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "A validade de um cartão pelo código (XXXX-XXXX-XXXX)" })
  async verify(@CurrentTenant() t: TenantContext, @Param("code", new ZodValidationPipe(z.string().min(1).max(40))) code: string) {
    return this.cards.verify(PrismaCardsRepository.for(t.db), code, t.entry.schoolName);
  }
}
