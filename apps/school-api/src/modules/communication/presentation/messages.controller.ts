import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { sendDocument } from "../../documents/presentation/documents.controller";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import type { SchoolAccess } from "../../identity/application/ports";
import { HrMay, NoTeachersGuard, permissionsOf, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { Announcements } from "../application/Announcements";
import { Conversations, type Me, type Settings } from "../application/Conversations";
import { MESSAGE_FILES_MAX } from "../domain/messages";
import { PrismaAnnouncementsRepository } from "../infrastructure/prisma-announcements";
import { PrismaConversationsRepository } from "../infrastructure/prisma-conversations";
import { COMMUNICATION_HTTP, communicationNotices } from "./announcements.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const party = z.object({ kind: z.enum(["STAFF", "FAMILY"]), id: z.uuid() });
const directBody = z.object({ with: party }).meta({ title: "ConversationDirect", description: "Abrir (ou criar) a conversa com uma pessoa a quem se pode escrever." });
const groupBody = z
  .object({
    title: z.string().max(200),
    description: z.string().max(800).nullish(),
    groupType: z.enum(["MANUAL", "CLASS", "GRADE", "DEPARTMENT", "INSTITUTION"]),
    refId: z.string().max(40).nullish(),
    refText: z.string().max(200).nullish(),
    audience: z.enum(["GUARDIANS", "TEACHERS", "STUDENTS", "ALL"]).nullish(),
    onlyAdminsPost: z.boolean().nullish(),
    membersCanAdd: z.boolean().nullish(),
    members: z.array(party).max(300).default([]),
  })
  .meta({ title: "ConversationGroup", description: "Um grupo manual (com as pessoas escolhidas) ou ligado a uma turma (CLASS), classe (GRADE), departamento ou à equipa (INSTITUTION)." });
const groupUpdateBody = z.object({ title: z.string().max(200), description: z.string().max(800).nullish(), onlyAdminsPost: z.boolean(), membersCanAdd: z.boolean() }).meta({ title: "ConversationGroupUpdate" });
const membersBody = z.object({ members: z.array(party).min(1).max(300) }).meta({ title: "ConversationMembers" });
const roleBody = z.object({ admin: z.boolean() }).meta({ title: "ConversationRole" });
const archiveBody = z.object({ archived: z.boolean() }).meta({ title: "ConversationArchive" });
const listQuery = new ZodValidationPipe(z.object({ arquivadas: z.enum(["1", "0"]).optional(), q: z.string().max(120).optional() }));
const contactsQuery = new ZodValidationPipe(z.object({ q: z.string().max(80).optional() }));
const msgQuery = new ZodValidationPipe(z.object({ antes: z.string().max(40).optional(), depois: z.string().max(40).optional() }));
const memberKind = new ZodValidationPipe(z.enum(["STAFF", "FAMILY"]));
/** texto em `body` (multipart) e até 5 ficheiros em `files` (PDF, JPG, PNG até 10 MB) */
const SEND = FilesInterceptor("files", MESSAGE_FILES_MAX, { limits: { fileSize: 10 * 1024 * 1024 + 1, files: MESSAGE_FILES_MAX, fields: 2 } });
type Upload = { originalname: string; mimetype: string; buffer: Buffer };
const PHOTO = FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 + 1, files: 1, fields: 0 } });

async function settingsOf(t: TenantContext): Promise<Settings> {
  return PrismaAnnouncementsRepository.for(t.db).settings();
}

/**
 * COMUNICAÇÃO · MENSAGENS E GRUPOS (equipa, incluindo professores e RH). Cada pessoa vê só as conversas de
 * que é membro; quem pode falar com quem decide-se no serviço (relações académicas e configuração).
 */
@ApiTags("Portal · Comunicação · Mensagens")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/communication")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
@TeacherMay()
@HrMay()
export class MessagesController {
  constructor(
    private readonly conversations: Conversations,
    private readonly announcements: Announcements,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaConversationsRepository.for(t.db);
  }
  private async me(t: TenantContext, u: SchoolAccess): Promise<Me> {
    return { party: { kind: "STAFF", id: u.id }, name: u.fullName ?? "Equipa do colégio", permissions: await permissionsOf(t.db, u), support: !!u.support };
  }

  @Get("unread")
  @ApiOperation({ summary: "Contadores (consulta curta, ~30 s): mensagens por ler, conversas com novidades e avisos por ler" })
  async unread(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    const [m, a] = await Promise.all([this.conversations.unread(this.repo(t), await this.me(t, u)), this.announcements.unread(PrismaAnnouncementsRepository.for(t.db), { kind: "STAFF", id: u.id })]);
    return { ...m, announcements: a.unread };
  }

  @Get("avatars/:kind/:memberId")
  @ApiOperation({ summary: "A fotografia de alguém (eu, quem partilha uma conversa comigo, ou um contacto)" })
  async avatar(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("kind", memberKind) kind: "STAFF" | "FAMILY", @Param("memberId", id) memberId: string, @Res({ passthrough: true }) res: Response) {
    const f = unwrap(await this.conversations.avatar(this.repo(t), await settingsOf(t), this.stores.for(t.entry), await this.me(t, u), { kind, id: memberId }), COMMUNICATION_HTTP);
    return sendDocument(res, f);
  }

  @Get("me/photo")
  @ApiOperation({ summary: "A minha fotografia: se escolhi uma e se há alguma" })
  async myPhoto(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.conversations.myPhoto(this.repo(t), await this.me(t, u));
  }

  @Post("me/photo")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(PHOTO)
  @ApiOperation({ summary: "Escolher a minha fotografia (JPG ou PNG até 5 MB)" })
  async uploadPhoto(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @UploadedFile() file: Upload | undefined) {
    return unwrap(await this.conversations.uploadPhoto(this.repo(t), this.stores.for(t.entry), await this.me(t, u), file), COMMUNICATION_HTTP);
  }

  @Delete("me/photo")
  @ApiOperation({ summary: "Voltar à fotografia por omissão (a anterior fica guardada)" })
  async removePhoto(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return unwrap(await this.conversations.removePhoto(this.repo(t), await this.me(t, u)), COMMUNICATION_HTTP);
  }

  @Get("contacts")
  @ApiOperation({ summary: "Com quem posso iniciar uma conversa (?q=) e que grupos posso criar" })
  async contacts(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(contactsQuery) q: { q?: string }) {
    return unwrap(await this.conversations.contactList(this.repo(t), await settingsOf(t), await this.me(t, u), q.q ?? null), COMMUNICATION_HTTP);
  }

  @Get("conversations")
  @ApiOperation({ summary: "As minhas conversas e grupos (?arquivadas=1, ?q=), com a última mensagem e as por ler" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(listQuery) q: { arquivadas?: string; q?: string }) {
    return unwrap(await this.conversations.list(this.repo(t), await this.me(t, u), { archived: q.arquivadas === "1", q: q.q }), COMMUNICATION_HTTP);
  }

  @Post("conversations")
  @ApiOperation({ summary: "Abrir (ou criar) a conversa individual com uma pessoa" })
  @ApiBody({ schema: openApi(directBody) })
  async direct(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(directBody)) body: z.infer<typeof directBody>) {
    return unwrap(await this.conversations.startDirect(this.repo(t), await settingsOf(t), await this.me(t, u), body.with), COMMUNICATION_HTTP);
  }

  @Post("groups")
  @ApiOperation({ summary: "Criar um grupo (manual ou ligado a turma, classe, departamento ou equipa)" })
  @ApiBody({ schema: openApi(groupBody) })
  async createGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(groupBody)) body: z.infer<typeof groupBody>) {
    const { members, ...input } = body;
    return unwrap(await this.conversations.createGroup(this.repo(t), await settingsOf(t), communicationNotices(this.notifier, t), await this.me(t, u), input, members), COMMUNICATION_HTTP);
  }

  @Get("conversations/:id")
  @ApiOperation({ summary: "Uma conversa: dados, membros e o que posso fazer" })
  async view(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string) {
    return unwrap(await this.conversations.view(this.repo(t), communicationNotices(this.notifier, t), await this.me(t, u), cid), COMMUNICATION_HTTP);
  }

  @Get("conversations/:id/messages")
  @ApiOperation({ summary: "As mensagens (?antes= para trás; ?depois= as novas — consulta curta) e os recibos dos outros" })
  async messages(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Query(msgQuery) q: { antes?: string; depois?: string }) {
    return unwrap(await this.conversations.messages(this.repo(t), await this.me(t, u), cid, { before: q.antes, after: q.depois }), COMMUNICATION_HTTP);
  }

  @Post("conversations/:id/messages")
  @ApiConsumes("multipart/form-data", "application/json")
  @UseInterceptors(SEND)
  @ApiOperation({ summary: "Enviar uma mensagem (texto em `body`; até 5 ficheiros em `files`)" })
  async send(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Body() body: { body?: string }, @UploadedFiles() files: Upload[] | undefined) {
    return unwrap(await this.conversations.send(this.repo(t), this.stores.for(t.entry), communicationNotices(this.notifier, t), await this.me(t, u), cid, body?.body, files ?? []), COMMUNICATION_HTTP);
  }

  @Post("conversations/:id/read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Marcar a conversa como lida" })
  async read(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string) {
    return unwrap(await this.conversations.read(this.repo(t), await this.me(t, u), cid), COMMUNICATION_HTTP);
  }

  @Put("conversations/:id/archive")
  @ApiOperation({ summary: "Arquivar ou desarquivar (só para mim)" })
  @ApiBody({ schema: openApi(archiveBody) })
  async archive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Body(new ZodValidationPipe(archiveBody)) body: { archived: boolean }) {
    return unwrap(await this.conversations.archive(this.repo(t), await this.me(t, u), cid, body.archived), COMMUNICATION_HTTP);
  }

  @Get("conversations/:id/files/:fileId")
  @ApiOperation({ summary: "Abrir um anexo (só membros; só das mensagens que podiam ler)" })
  async file(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.conversations.file(this.repo(t), this.stores.for(t.entry), await this.me(t, u), cid, fileId), COMMUNICATION_HTTP));
  }

  @Put("groups/:id")
  @ApiOperation({ summary: "Alterar o grupo (administradores): nome, descrição, só administradores escrevem, membros juntam pessoas" })
  @ApiBody({ schema: openApi(groupUpdateBody) })
  async updateGroup(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Body(new ZodValidationPipe(groupUpdateBody)) body: z.infer<typeof groupUpdateBody>) {
    return unwrap(await this.conversations.updateGroup(this.repo(t), await this.me(t, u), cid, body), COMMUNICATION_HTTP);
  }

  @Post("groups/:id/members")
  @ApiOperation({ summary: "Juntar pessoas ao grupo" })
  @ApiBody({ schema: openApi(membersBody) })
  async addMembers(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Body(new ZodValidationPipe(membersBody)) body: z.infer<typeof membersBody>) {
    return unwrap(await this.conversations.addMembers(this.repo(t), await settingsOf(t), communicationNotices(this.notifier, t), await this.me(t, u), cid, body.members), COMMUNICATION_HTTP);
  }

  @Delete("groups/:id/members/:kind/:memberId")
  @ApiOperation({ summary: "Retirar uma pessoa (administradores; o histórico fica)" })
  async removeMember(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Param("kind", memberKind) kind: "STAFF" | "FAMILY", @Param("memberId", id) memberId: string) {
    return unwrap(await this.conversations.removeMember(this.repo(t), await this.me(t, u), cid, { kind, id: memberId }), COMMUNICATION_HTTP);
  }

  @Put("groups/:id/members/:kind/:memberId/role")
  @ApiOperation({ summary: "Tornar (ou deixar de ser) administrador" })
  @ApiBody({ schema: openApi(roleBody) })
  async role(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string, @Param("kind", memberKind) kind: "STAFF" | "FAMILY", @Param("memberId", id) memberId: string, @Body(new ZodValidationPipe(roleBody)) body: { admin: boolean }) {
    return unwrap(await this.conversations.setAdmin(this.repo(t), await this.me(t, u), cid, { kind, id: memberId }, body.admin), COMMUNICATION_HTTP);
  }

  @Post("groups/:id/leave")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sair do grupo (deixa de ver as novas; o histórico fica)" })
  async leave(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) cid: string) {
    return unwrap(await this.conversations.leave(this.repo(t), await this.me(t, u), cid), COMMUNICATION_HTTP);
  }
}

/** Família · mensagens: o encarregado e o aluno maior falam com os professores e o diretor de turma (e o colégio). */
@ApiTags("Família · Mensagens")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/family/messages")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyMessagesController {
  constructor(
    private readonly conversations: Conversations,
    private readonly announcements: Announcements,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaConversationsRepository.for(t.db);
  }
  private me(f: FamilyPrincipal): Me {
    return { party: { kind: "FAMILY", id: f.account.id }, name: f.account.fullName, familyKind: f.account.kind === "STUDENT" ? "STUDENT" : "GUARDIAN" };
  }

  @Get("unread")
  @ApiOperation({ summary: "Contadores: mensagens por ler e avisos por ler" })
  async unread(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    const [m, a] = await Promise.all([this.conversations.unread(this.repo(t), this.me(f)), this.announcements.unread(PrismaAnnouncementsRepository.for(t.db), { kind: "FAMILY", id: f.account.id })]);
    return { ...m, announcements: a.unread };
  }

  @Get("avatars/:kind/:memberId")
  @ApiOperation({ summary: "A fotografia de alguém (quem partilha uma conversa comigo, ou um contacto)" })
  async avatar(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("kind", memberKind) kind: "STAFF" | "FAMILY", @Param("memberId", id) memberId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.conversations.avatar(this.repo(t), await settingsOf(t), this.stores.for(t.entry), this.me(f), { kind, id: memberId }), COMMUNICATION_HTTP));
  }

  @Get("me/photo")
  @ApiOperation({ summary: "A minha fotografia" })
  async myPhoto(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.conversations.myPhoto(this.repo(t), this.me(f));
  }

  @Post("me/photo")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(PHOTO)
  @ApiOperation({ summary: "Escolher a minha fotografia (JPG ou PNG até 5 MB)" })
  async uploadPhoto(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @UploadedFile() file: Upload | undefined) {
    return unwrap(await this.conversations.uploadPhoto(this.repo(t), this.stores.for(t.entry), this.me(f), file), COMMUNICATION_HTTP);
  }

  @Delete("me/photo")
  @ApiOperation({ summary: "Voltar à fotografia por omissão" })
  async removePhoto(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return unwrap(await this.conversations.removePhoto(this.repo(t), this.me(f)), COMMUNICATION_HTTP);
  }

  @Get("contacts")
  @ApiOperation({ summary: "Os professores e diretores de turma dos alunos da conta (?q=)" })
  async contacts(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Query(contactsQuery) q: { q?: string }) {
    return unwrap(await this.conversations.contactList(this.repo(t), await settingsOf(t), this.me(f), q.q ?? null), COMMUNICATION_HTTP);
  }

  @Get("conversations")
  @ApiOperation({ summary: "As conversas e grupos da conta" })
  async list(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Query(listQuery) q: { arquivadas?: string; q?: string }) {
    return unwrap(await this.conversations.list(this.repo(t), this.me(f), { archived: q.arquivadas === "1", q: q.q }), COMMUNICATION_HTTP);
  }

  @Post("conversations")
  @ApiOperation({ summary: "Abrir (ou criar) a conversa com um professor ou o diretor de turma" })
  @ApiBody({ schema: openApi(directBody) })
  async direct(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(directBody)) body: z.infer<typeof directBody>) {
    return unwrap(await this.conversations.startDirect(this.repo(t), await settingsOf(t), this.me(f), body.with), COMMUNICATION_HTTP);
  }

  @Get("conversations/:id")
  @ApiOperation({ summary: "Uma conversa" })
  async view(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string) {
    return unwrap(await this.conversations.view(this.repo(t), communicationNotices(this.notifier, t), this.me(f), cid), COMMUNICATION_HTTP);
  }

  @Get("conversations/:id/messages")
  @ApiOperation({ summary: "As mensagens (?antes=, ?depois=)" })
  async messages(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string, @Query(msgQuery) q: { antes?: string; depois?: string }) {
    return unwrap(await this.conversations.messages(this.repo(t), this.me(f), cid, { before: q.antes, after: q.depois }), COMMUNICATION_HTTP);
  }

  @Post("conversations/:id/messages")
  @ApiConsumes("multipart/form-data", "application/json")
  @UseInterceptors(SEND)
  @ApiOperation({ summary: "Enviar uma mensagem (texto em `body`; até 5 ficheiros em `files`)" })
  async send(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string, @Body() body: { body?: string }, @UploadedFiles() files: Upload[] | undefined) {
    return unwrap(await this.conversations.send(this.repo(t), this.stores.for(t.entry), communicationNotices(this.notifier, t), this.me(f), cid, body?.body, files ?? []), COMMUNICATION_HTTP);
  }

  @Post("conversations/:id/read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Marcar como lida" })
  async read(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string) {
    return unwrap(await this.conversations.read(this.repo(t), this.me(f), cid), COMMUNICATION_HTTP);
  }

  @Put("conversations/:id/archive")
  @ApiOperation({ summary: "Arquivar ou desarquivar" })
  @ApiBody({ schema: openApi(archiveBody) })
  async archive(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string, @Body(new ZodValidationPipe(archiveBody)) body: { archived: boolean }) {
    return unwrap(await this.conversations.archive(this.repo(t), this.me(f), cid, body.archived), COMMUNICATION_HTTP);
  }

  @Get("conversations/:id/files/:fileId")
  @ApiOperation({ summary: "Abrir um anexo" })
  async file(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string, @Param("fileId", id) fileId: string, @Res({ passthrough: true }) res: Response) {
    return sendDocument(res, unwrap(await this.conversations.file(this.repo(t), this.stores.for(t.entry), this.me(f), cid, fileId), COMMUNICATION_HTTP));
  }

  @Post("groups/:id/leave")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sair de um grupo" })
  async leave(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) cid: string) {
    return unwrap(await this.conversations.leave(this.repo(t), this.me(f), cid), COMMUNICATION_HTTP);
  }
}
