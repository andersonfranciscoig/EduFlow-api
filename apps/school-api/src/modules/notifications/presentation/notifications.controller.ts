import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, TeacherMay } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { NotificationsCenter, type NotificationsErrorCode, type NotifyActor } from "../application/NotificationsCenter";
import { PrismaNotificationsRepository } from "../infrastructure/prisma-notifications";

const HTTP: Partial<Record<NotificationsErrorCode, HttpStatus>> = { INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY, FORBIDDEN: HttpStatus.FORBIDDEN };
const readBody = z.object({ ids: z.array(z.uuid()).max(200).nullish() }).meta({ title: "NotificationsRead", description: "Sem ids: marca todas." });
const prefBody = z.object({ email: z.boolean() }).meta({ title: "NotificationPreference" });
const typeBody = z.object({ enabled: z.boolean(), email: z.boolean() }).meta({ title: "NotificationType", description: "Ligar/desligar o tipo e se também vai por email." });
const kindPipe = new ZodValidationPipe(z.string().regex(/^[A-Z_]{3,40}$/, "Tipo inválido."));
const listQuery = new ZodValidationPipe(
  z.object({ tipo: z.string().max(40).optional(), estado: z.string().max(10).optional(), canal: z.string().max(10).optional(), publico: z.string().max(10).optional(), pagina: z.coerce.number().int().min(1).max(1000).optional() }),
);
const actorOf = (u: SchoolAccess): NotifyActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/**
 * Notificações da equipa. A caixa e as preferências são de cada pessoa (professores incluídos).
 * Os tipos do colégio e o histórico de envios: a direção (alterar) e a gestão (consultar).
 */
@ApiTags("Portal · Notificações")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/notifications")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class NotificationsController {
  constructor(private readonly center: NotificationsCenter) {}

  private repo(t: TenantContext) {
    return new PrismaNotificationsRepository(t.db);
  }

  @Get()
  @TeacherMay()
  @ApiOperation({ summary: "A minha caixa (as últimas 100) e o n.º por ler" })
  inbox(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.center.inbox(this.repo(t), u.id);
  }

  @Get("unread")
  @TeacherMay()
  @ApiOperation({ summary: "N.º de notificações por ler (para o menu)" })
  unread(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.center.unread(this.repo(t), u.id);
  }

  @Post("read")
  @TeacherMay()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Marcar como lidas (as indicadas ou todas)" })
  @ApiBody({ schema: openApi(readBody) })
  read(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(readBody)) body: z.infer<typeof readBody>) {
    return this.center.markRead(this.repo(t), u.id, body.ids ?? null);
  }

  @Get("preferences")
  @TeacherMay()
  @ApiOperation({ summary: "As minhas preferências de email por tipo" })
  preferences(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.center.preferences(this.repo(t), u.id);
  }

  @Put("preferences/:kind")
  @TeacherMay()
  @ApiOperation({ summary: "Receber (ou não) o email de um tipo" })
  @ApiBody({ schema: openApi(prefBody) })
  async setPreference(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("kind", kindPipe) kind: string, @Body(new ZodValidationPipe(prefBody)) body: z.infer<typeof prefBody>) {
    return unwrap(await this.center.setPreference(this.repo(t), u.id, kind, body.email), HTTP);
  }

  @Get("settings")
  @ApiOperation({ summary: "Tipos de notificação do colégio (equipa e família) e envios dos últimos 30 dias" })
  settings(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.center.settings(this.repo(t), actorOf(u));
  }

  @Put("settings/:kind")
  @ApiOperation({ summary: "Ligar/desligar um tipo e escolher se vai por email (direção)" })
  @ApiBody({ schema: openApi(typeBody) })
  async setType(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("kind", kindPipe) kind: string, @Body(new ZodValidationPipe(typeBody)) body: z.infer<typeof typeBody>) {
    return unwrap(await this.center.setType(this.repo(t), actorOf(u), kind, body), HTTP);
  }

  @Get("deliveries")
  @ApiOperation({ summary: "Histórico de envios (filtros: tipo, estado, canal, público, página)" })
  async deliveries(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(listQuery) q: { tipo?: string; estado?: string; canal?: string; publico?: string; pagina?: number }) {
    // o histórico mostra nomes e emails: só a direção (nunca uma sessão de suporte)
    if (u.support || !(u.isOwner || u.role === "DIRETOR")) throw new ForbiddenException({ code: "FORBIDDEN", message: "Só a direção pode ver o histórico de envios." });
    return this.center.deliveries(this.repo(t), { kind: q.tipo, status: q.estado, channel: q.canal, audience: q.publico, page: q.pagina });
  }
}
