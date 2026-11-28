import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { sendDocument } from "../../documents/presentation/documents.controller";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, permissionsOf, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { type AnnouncementBody, Announcements, type Notices, type StaffViewer } from "../application/Announcements";
import { type CommunicationErrorCode, STATUSES, TARGET_KINDS } from "../domain/announcements";
import { PrismaAnnouncementsRepository } from "../infrastructure/prisma-announcements";

export const COMMUNICATION_HTTP: Partial<Record<CommunicationErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  CHANGED: HttpStatus.CONFLICT,
  NOT_AVAILABLE: HttpStatus.CONFLICT,
  NAME_TAKEN: HttpStatus.CONFLICT,
};

/** Os avisos que saem para a equipa (Notifier) e para a família (área da família). */
export const communicationNotices = (notifier: Notifier, t: TenantContext): Notices => ({
  staff: notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName }),
  family: (accountId, n) => notifyFamily(t.db, { accountId, kind: n.kind, title: n.title, body: n.body, link: n.link, now: new Date() }),
});

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const target = z.object({ kind: z.enum(TARGET_KINDS), refId: z.string().max(40).nullish(), refText: z.string().max(200).nullish(), audience: z.enum(["STUDENTS", "GUARDIANS", "BOTH"]).nullish() });
export const announcementBody = z
  .object({
    title: z.string().max(400),
    body: z.string().max(20000),
    categoryId: z.string().max(40),
    priority: z.enum(["NORMAL", "HIGH", "URGENT"]).nullish(),
    pinned: z.boolean().nullish(),
    requiresAck: z.boolean().nullish(),
    publishAt: z.string().max(40).nullish(),
    expiresAt: z.string().max(40).nullish(),
    targets: z.array(target).max(100),
    action: z.enum(["DRAFT", "PUBLISH"]),
  })
  .meta({ title: "Announcement", description: "Título, texto, categoria, prioridade, fixar, confirmação de leitura, agendamento (publishAt), expiração e destinatários. action: DRAFT guarda; PUBLISH publica já (ou agenda, com publishAt)." });
const updateBody = announcementBody.extend({ revision: z.number().int().min(1) }).meta({ title: "AnnouncementUpdate" });
const patchBody = z.object({ pinned: z.boolean().optional(), expiresAt: z.string().max(40).nullable().optional() }).meta({ title: "AnnouncementPatch", description: "Num aviso publicado: fixar e a expiração." });
const settingsBody = z
  .object({ classDirectorsPublish: z.boolean().optional(), studentsMessage: z.boolean().optional(), staffMessage: z.boolean().optional(), teachersCreateGroups: z.boolean().optional() })
  .meta({ title: "CommunicationSettings", description: "Diretores de turma publicam para as suas turmas; alunos (com conta) escrevem aos professores; a equipa escreve entre si; professores criam grupos." });
const categoryBody = z.object({ name: z.string().max(120), archived: z.boolean().optional() }).meta({ title: "AnnouncementCategory" });
const inboxQuery = new ZodValidationPipe(z.object({ categoria: z.uuid().optional(), q: z.string().max(120).optional(), porLer: z.enum(["1", "0"]).optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }));
const listQuery = new ZodValidationPipe(z.object({ estado: z.enum(STATUSES).optional(), categoria: z.uuid().optional(), q: z.string().max(120).optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }));
const statsQuery = new ZodValidationPipe(z.object({ leitura: z.enum(["ALL", "VIEWED", "NOT_VIEWED", "ACK", "NOT_ACK"]).optional() }));
const peopleQuery = new ZodValidationPipe(z.object({ q: z.string().max(80).default("") }));
const ATTACH = FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 + 1, files: 1, fields: 0 } });
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;

/**
 * COMUNICAÇÃO · AVISOS (equipa). Receber e ler: qualquer pessoa da equipa (professores e RH incluídos),
 * só os avisos que lhe foram destinados. Publicar e gerir: com as permissões communication.* ou, se o
 * colégio o permitir, o diretor de turma para as suas turmas. Tudo validado no serviço.
 */
@ApiTags("Portal · Comunicação · Avisos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/communication")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
@TeacherMay()
@HrMay()
export class AnnouncementsController {
  constructor(
    private readonly announcements: Announcements,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaAnnouncementsRepository.for(t.db);
  }
  private notices(t: TenantContext) {
    return communicationNotices(this.notifier, t);
  }
  private async viewer(t: TenantContext, u: SchoolAccess): Promise<StaffViewer> {
    return { userId: u.id, name: u.fullName ?? "Equipa do colégio", support: !!u.support, permissions: await permissionsOf(t.db, u) };
  }
  private me(u: SchoolAccess) {
    return { kind: "STAFF" as const, id: u.id };
  }

  // ---------------------------------------------------------------- receber

  @Get("announcements")
  @ApiOperation({ summary: "Os meus avisos (publicados e por expirar): fixados primeiro; filtros categoria, q, porLer" })
  async inbox(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(inboxQuery) q: { categoria?: string; q?: string; porLer?: string; pagina?: number }) {
    return this.announcements.inbox(this.repo(t), this.notices(t), this.me(u), { categoryId: q.categoria, q: q.q, unread: q.porLer === "1", page: q.pagina });
  }

  @Get("announcements/unread")
  @ApiOperation({ summary: "Quantos avisos tenho por ler" })
  async unread(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.announcements.unread(this.repo(t), this.me(u));
  }

  // ---------------------------------------------------------------- gerir (antes de :id)

  @Get("announcements/manage/options")
  @ApiOperation({ summary: "Para escrever um aviso: o que posso publicar, categorias, classes, turmas, departamentos e as minhas turmas (diretor de turma)" })
  async options(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.announcements.options(this.repo(t), await this.viewer(t, u)), COMMUNICATION_HTTP);
  }

  @Get("announcements/manage/people")
  @ApiOperation({ summary: "Procurar pessoas para destinatários (equipa e, com toda a comunidade, famílias)" })
  async people(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(peopleQuery) q: { q: string }) {
    return unwrap(await this.announcements.searchPeople(this.repo(t), await this.viewer(t, u), q.q), COMMUNICATION_HTTP);
  }

  @Get("announcements/manage")
  @ApiOperation({ summary: "Os avisos que gero (todos, com communication.announcements.manage): rascunhos, agendados, publicados, arquivados, com os indicadores" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(listQuery) q: { estado?: (typeof STATUSES)[number]; categoria?: string; q?: string; pagina?: number }) {
    return unwrap(await this.announcements.list(this.repo(t), this.notices(t), await this.viewer(t, u), { status: q.estado, categoryId: q.categoria, q: q.q, page: q.pagina }), COMMUNICATION_HTTP);
  }

  @Post("announcements/manage")
  @ApiOperation({ summary: "Criar um aviso (rascunho, publicar já ou agendar)" })
  @ApiBody({ schema: openApi(announcementBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(announcementBody)) body: AnnouncementBody) {
    return unwrap(await this.announcements.create(this.repo(t), this.notices(t), await this.viewer(t, u), body), COMMUNICATION_HTTP);
  }

  @Get("announcements/manage/:id")
  @ApiOperation({ summary: "Um aviso para quem o gere: destinatários, anexos e indicadores de leitura (?leitura=ALL|VIEWED|NOT_VIEWED|ACK|NOT_ACK)" })
  async manageView(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string, @Query(statsQuery) q: { leitura?: "ALL" | "VIEWED" | "NOT_VIEWED" | "ACK" | "NOT_ACK" }) {
    return unwrap(await this.announcements.manageView(this.repo(t), await this.viewer(t, u), announcementId, q.leitura ?? "ALL"), COMMUNICATION_HTTP);
  }

  @Put("announcements/manage/:id")
  @ApiOperation({ summary: "Alterar um rascunho ou agendado (com a revisão que se está a ver)" })
  @ApiBody({ schema: openApi(updateBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string, @Body(new ZodValidationPipe(updateBody)) body: AnnouncementBody & { revision: number }) {
    return unwrap(await this.announcements.update(this.repo(t), this.notices(t), await this.viewer(t, u), announcementId, body.revision, body), COMMUNICATION_HTTP);
  }

  @Patch("announcements/manage/:id")
  @ApiOperation({ summary: "Num publicado: fixar no topo e a expiração" })
  @ApiBody({ schema: openApi(patchBody) })
  async patch(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string, @Body(new ZodValidationPipe(patchBody)) body: { pinned?: boolean; expiresAt?: string | null }) {
    return unwrap(await this.announcements.patch(this.repo(t), await this.viewer(t, u), announcementId, body), COMMUNICATION_HTTP);
  }

  @Post("announcements/manage/:id/publish")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Publicar já um rascunho ou agendado" })
  async publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.publish(this.repo(t), this.notices(t), await this.viewer(t, u), announcementId), COMMUNICATION_HTTP);
  }

  @Post("announcements/manage/:id/archive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Arquivar (deixa de aparecer a quem o recebeu; os indicadores ficam)" })
  async archive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.archive(this.repo(t), await this.viewer(t, u), announcementId), COMMUNICATION_HTTP);
  }

  @Delete("announcements/manage/:id")
  @ApiOperation({ summary: "Apagar um rascunho" })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.removeDraft(this.repo(t), await this.viewer(t, u), announcementId), COMMUNICATION_HTTP);
  }

  @Post("announcements/manage/:id/files")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(ATTACH)
  @ApiOperation({ summary: "Juntar um anexo (PDF, JPG ou PNG até 10 MB; até 5)" })
  async attach(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string, @UploadedFile() file: Upload) {
    return unwrap(await this.announcements.attach(this.repo(t), this.stores.for(t.entry), await this.viewer(t, u), announcementId, file), COMMUNICATION_HTTP);
  }

  @Delete("announcements/manage/:id/files/:fileId")
  @ApiOperation({ summary: "Retirar um anexo de um rascunho ou agendado (o ficheiro fica guardado)" })
  async detach(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string, @Param("fileId", id) fileId: string) {
    return unwrap(await this.announcements.detach(this.repo(t), await this.viewer(t, u), announcementId, fileId), COMMUNICATION_HTTP);
  }

  // ---------------------------------------------------------------- configuração

  @Get("settings")
  @ApiOperation({ summary: "A configuração da comunicação: diretores de turma e categorias" })
  async settings(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.announcements.settingsView(this.repo(t), await this.viewer(t, u)), COMMUNICATION_HTTP);
  }

  @Put("settings")
  @ApiOperation({ summary: "Guardar a configuração (os diretores de turma podem publicar para as suas turmas)" })
  @ApiBody({ schema: openApi(settingsBody) })
  async saveSettings(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(settingsBody)) body: z.infer<typeof settingsBody>) {
    return unwrap(await this.announcements.saveSettings(this.repo(t), await this.viewer(t, u), body), COMMUNICATION_HTTP);
  }

  @Post("settings/categories")
  @ApiOperation({ summary: "Nova categoria de avisos" })
  @ApiBody({ schema: openApi(categoryBody) })
  async addCategory(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(categoryBody)) body: { name: string }) {
    return unwrap(await this.announcements.saveCategory(this.repo(t), await this.viewer(t, u), null, body), COMMUNICATION_HTTP);
  }

  @Put("settings/categories/:id")
  @ApiOperation({ summary: "Mudar o nome de uma categoria ou arquivá-la (não se apagam)" })
  @ApiBody({ schema: openApi(categoryBody) })
  async saveCategory(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) categoryId: string, @Body(new ZodValidationPipe(categoryBody)) body: { name: string; archived?: boolean }) {
    return unwrap(await this.announcements.saveCategory(this.repo(t), await this.viewer(t, u), categoryId, body), COMMUNICATION_HTTP);
  }

  // ---------------------------------------------------------------- um aviso recebido (depois das rotas fixas)

  @Get("announcements/:id")
  @ApiOperation({ summary: "Abrir um aviso que me foi destinado (fica visto)" })
  async read(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.read(this.repo(t), this.me(u), announcementId), COMMUNICATION_HTTP);
  }

  @Post("announcements/:id/ack")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirmar a leitura (quando o aviso o pede)" })
  async ack(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.acknowledge(this.repo(t), this.me(u), announcementId), COMMUNICATION_HTTP);
  }

  @Get("announcements/:id/files/:fileId")
  @ApiOperation({ summary: "Abrir um anexo (quem recebeu o aviso, ou quem o gere)" })
  async file(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) announcementId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.announcements.file(this.repo(t), this.stores.for(t.entry), announcementId, fileId, { staff: await this.viewer(t, u) }), COMMUNICATION_HTTP));
  }
}

/** Família · avisos: o encarregado e o aluno maior veem só os que lhes foram destinados. */
@ApiTags("Família · Avisos")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/family/announcements")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyAnnouncementsController {
  constructor(
    private readonly announcements: Announcements,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaAnnouncementsRepository.for(t.db);
  }
  private me(f: FamilyPrincipal) {
    return { kind: "FAMILY" as const, id: f.account.id };
  }

  @Get()
  @ApiOperation({ summary: "Os avisos da conta (publicados e por expirar)" })
  async inbox(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Query(inboxQuery) q: { categoria?: string; q?: string; porLer?: string; pagina?: number }) {
    return this.announcements.inbox(this.repo(t), communicationNotices(this.notifier, t), this.me(f), { categoryId: q.categoria, q: q.q, unread: q.porLer === "1", page: q.pagina });
  }

  @Get("unread")
  @ApiOperation({ summary: "Quantos avisos estão por ler" })
  async unread(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.announcements.unread(this.repo(t), this.me(f));
  }

  @Get(":id")
  @ApiOperation({ summary: "Abrir um aviso (fica visto)" })
  async read(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.read(this.repo(t), this.me(f), announcementId), COMMUNICATION_HTTP);
  }

  @Post(":id/ack")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirmar a leitura" })
  async ack(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) announcementId: string) {
    return unwrap(await this.announcements.acknowledge(this.repo(t), this.me(f), announcementId), COMMUNICATION_HTTP);
  }

  @Get(":id/files/:fileId")
  @ApiOperation({ summary: "Abrir um anexo do aviso" })
  async file(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) announcementId: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.announcements.file(this.repo(t), this.stores.for(t.entry), announcementId, fileId, { recipient: this.me(f) }), COMMUNICATION_HTTP));
  }
}
