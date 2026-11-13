import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { ClientInfo, SchoolAccess } from "../../identity/application/ports";
import { Client } from "../../identity/presentation/http/http-support";
import { RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Registration } from "../application/Registration";
import { PrismaHrSettingsRepository } from "../infrastructure/prisma-hr-settings";
import { PrismaRegistrationRepository } from "../infrastructure/prisma-registration";
import { HR_HTTP } from "./hr-settings.controller";

const MINUTE = 60_000;
const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const requestBody = z
  .object({
    fullName: z.string().min(3).max(120),
    email: z.string().max(254),
    phone: z.string().max(30).nullish(),
    password: z.string().min(1).max(128),
    employeeTypeId: z.uuid().nullish(),
    acceptTerms: z.boolean(),
  })
  .meta({ title: "RegistrationRequest", description: "Pedido de cadastro de funcionário (página pública do colégio)." });
const approveBody = z.object({ employeeTypeId: z.uuid().nullish() }).meta({ title: "RegistrationApprove", description: "Tipo de funcionário confirmado (obrigatório se a versão em uso tiver tipos)." });
const rejectBody = z.object({ reason: z.string().max(500), notify: z.boolean().default(false) }).meta({ title: "RegistrationReject", description: "Justificação (obrigatória); notify = mostrar a justificação no email à pessoa." });
const cancelBody = z.object({ reason: z.string().max(500) }).meta({ title: "RegistrationCancel" });
const listQuery = z.object({ status: z.string().max(20).optional(), q: z.string().max(80).optional(), page: z.coerce.number().int().min(1).max(10_000).optional() });

const school = (t: TenantContext) => ({ slug: t.entry.slug, name: t.entry.schoolName });
const actorOf = (u: SchoolAccess) => (u.support ? { id: null, name: null } : { id: u.id, name: u.fullName });

/**
 * Página pública do colégio: pedir o cadastro como funcionário (sem sessão).
 * O colégio vem do Host/X-Tenant (TenantGuard), nunca do corpo do pedido.
 */
@ApiTags("Portal público · Pedido de cadastro")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/public/hr/registration")
@UseGuards(TenantGuard)
export class PublicRegistrationController {
  constructor(private readonly registration: Registration) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: MINUTE } })
  @ApiOperation({ summary: "Se o colégio aceita pedidos de cadastro e que funções existem" })
  info(@CurrentTenant() t: TenantContext) {
    return this.registration.publicInfo(new PrismaHrSettingsRepository(t.db), school(t));
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Pedir o cadastro", description: "Resposta igual mesmo se o email já tiver pedido em aberto (não revela quem pediu); 409 FORM_NOT_PUBLISHED." })
  @ApiBody({ schema: openApi(requestBody) })
  async submit(@CurrentTenant() t: TenantContext, @Client() client: ClientInfo, @Body(new ZodValidationPipe(requestBody)) body: z.infer<typeof requestBody>) {
    return unwrap(await this.registration.submit(new PrismaRegistrationRepository(t.db), new PrismaHrSettingsRepository(t.db), school(t), body, client), HR_HTTP);
  }
}

/** Pedidos de cadastro na área de Recursos Humanos. */
@ApiTags("Portal · Recursos Humanos · Pedidos de cadastro")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/hr/registration-requests")
@UseGuards(TenantGuard, SchoolAuthGuard)
export class RegistrationRequestsController {
  constructor(private readonly registration: Registration) {}

  private repo(t: TenantContext) {
    return new PrismaRegistrationRepository(t.db);
  }

  @Get()
  @RequirePermission("hr.registration_requests.view")
  @ApiOperation({ summary: "Pedidos (?status=PENDING|APPROVED|REJECTED|CANCELLED, ?q=, ?page=) com contagens por estado" })
  async list(@CurrentTenant() t: TenantContext, @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.registration.list(this.repo(t), q);
  }

  @Get(":id")
  @RequirePermission("hr.registration_requests.view")
  @ApiOperation({ summary: "Pedido com histórico de decisões e o estado do convite" })
  async detail(@CurrentTenant() t: TenantContext, @Param("id", id) requestId: string) {
    return unwrap(await this.registration.detail(this.repo(t), new PrismaHrSettingsRepository(t.db), requestId), HR_HTTP);
  }

  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.registration_requests.approve")
  @ApiOperation({ summary: "Aprovar e enviar o convite (email com link válido 7 dias)", description: "409 INVALID_STATE se já foi decidido; FORM_NOT_PUBLISHED sem versão publicada." })
  @ApiBody({ schema: openApi(approveBody) })
  async approve(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(approveBody)) body: z.infer<typeof approveBody>) {
    return unwrap(await this.registration.approve(this.repo(t), new PrismaHrSettingsRepository(t.db), school(t), actorOf(u), requestId, body), HR_HTTP);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.registration_requests.reject")
  @ApiOperation({ summary: "Rejeitar (justificação obrigatória)" })
  @ApiBody({ schema: openApi(rejectBody) })
  async reject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(rejectBody)) body: z.infer<typeof rejectBody>) {
    return unwrap(await this.registration.reject(this.repo(t), school(t), actorOf(u), requestId, body), HR_HTTP);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.registration_requests.reject")
  @ApiOperation({ summary: "Cancelar um pedido pendente ou aprovado (o convite deixa de valer)" })
  @ApiBody({ schema: openApi(cancelBody) })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(cancelBody)) body: z.infer<typeof cancelBody>) {
    return unwrap(await this.registration.cancel(this.repo(t), actorOf(u), requestId, body), HR_HTTP);
  }

  @Post(":id/resend-invite")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.registration_requests.approve")
  @ApiOperation({ summary: "Novo convite (o anterior deixa de valer)", description: "502 EMAIL_NOT_SENT se o email falhar (o convite fica criado)." })
  async resend(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) requestId: string) {
    return unwrap(await this.registration.resendInvite(this.repo(t), school(t), actorOf(u), requestId), HR_HTTP);
  }
}
