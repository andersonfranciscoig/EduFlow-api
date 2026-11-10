import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { apiErrorSchema, openApi } from "../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../../tenancy/tenant-context";
import { AccountRecovery } from "../../application/AccountRecovery";
import { GetProfile } from "../../application/GetProfile";
import type { ClientInfo, SchoolAccess } from "../../application/ports";
import { SchoolSecurity } from "../../application/SchoolSecurity";
import { SchoolSignIn } from "../../application/SchoolSignIn";
import { TenantScopes } from "../../infrastructure/tenant-scopes";
import {
  type ChallengeBody,
  type ChallengeCodeBody,
  challengeCodeSchema,
  challengeSchema,
  type IdentifyBody,
  identifyResponseSchema,
  identifySchema,
  loginStepSchema,
  mfaConfirmResponseSchema,
  mfaSetupSchema,
  type SendCodeBody,
  sendCodeResponseSchema,
  sendCodeSchema,
  sessionResponseSchema,
  type SetPasswordBody,
  setPasswordSchema,
  type SignInBody,
  signInSchema,
  ticketResponseSchema,
  type VerifyCodeBody,
  verifyCodeSchema,
} from "./auth.schemas";
import { Client, orThrow } from "./http-support";
import { CurrentUser, SchoolAuth } from "./school-auth";

const MINUTE = 60_000;
const error = openApi(apiErrorSchema);

/**
 * Autenticação do portal do colégio — sempre com 2 fatores:
 *   identify → sign-in (senha) → mfa/verify (código)       ou  → mfa/setup → mfa/setup/confirm
 *   ativar conta / repor senha: codes → codes/verify → password → (2FA)
 * Tudo acontece na BD do colégio do pedido; os tokens só valem para ele.
 */
@ApiTags("Portal · Autenticação")
@ApiHeader({ name: "X-Tenant", required: false, description: "Slug do colégio (enviado pelo servidor do portal)" })
@ApiResponse({ status: 404, description: "Colégio não encontrado", schema: error })
@Controller("v1/auth")
@UseGuards(TenantGuard)
export class AuthController {
  constructor(
    private readonly scopes: TenantScopes,
    private readonly signIn: SchoolSignIn,
    private readonly recovery: AccountRecovery,
    private readonly security: SchoolSecurity,
    private readonly profile: GetProfile,
  ) {}

  // ================================================================ 1.º fator

  @Post("identify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: "Passo 1 — identificar a conta neste colégio" })
  @ApiBody({ schema: openApi(identifySchema) })
  @ApiResponse({ status: 200, description: "Resultado", schema: openApi(identifyResponseSchema, "output") })
  async identify(@CurrentTenant() tenant: TenantContext, @Body(new ZodValidationPipe(identifySchema)) body: IdentifyBody) {
    return orThrow(await this.signIn.identify(this.scopes.for(tenant), body.identifier));
  }

  @Post("sign-in")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Passo 2 — senha", description: "Senha certa → bilhete para a 2FA. Ainda não dá acesso." })
  @ApiBody({ schema: openApi(signInSchema) })
  @ApiResponse({ status: 200, description: "Falta a 2FA", schema: openApi(loginStepSchema, "output") })
  @ApiResponse({ status: 401, description: "Credenciais inválidas", schema: error })
  @ApiResponse({ status: 423, description: "Conta temporariamente bloqueada", schema: error })
  async password(@CurrentTenant() tenant: TenantContext, @Body(new ZodValidationPipe(signInSchema)) body: SignInBody) {
    return orThrow(await this.signIn.password(this.scopes.for(tenant), body));
  }

  // ================================================================ ativação e recuperação (código por email)

  @Post("codes")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @ApiOperation({ summary: "Enviar código por email (ativar conta ou repor senha)", description: "Resposta igual se a conta não existir." })
  @ApiBody({ schema: openApi(sendCodeSchema) })
  @ApiResponse({ status: 200, description: "Pedido aceite", schema: openApi(sendCodeResponseSchema, "output") })
  @ApiResponse({ status: 429, description: "Aguarde antes de pedir outro código", schema: error })
  async sendCode(@CurrentTenant() tenant: TenantContext, @Body(new ZodValidationPipe(sendCodeSchema)) body: SendCodeBody) {
    return orThrow(await this.recovery.send(this.scopes.for(tenant), body));
  }

  @Post("codes/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Confirmar o código recebido por email", description: "Devolve um bilhete de 10 min para definir a senha." })
  @ApiBody({ schema: openApi(verifyCodeSchema) })
  @ApiResponse({ status: 200, description: "Código certo", schema: openApi(ticketResponseSchema, "output") })
  @ApiResponse({ status: 401, description: "Código incorreto", schema: error })
  @ApiResponse({ status: 410, description: "Código expirado ou esgotado", schema: error })
  async verifyCode(@CurrentTenant() tenant: TenantContext, @Body(new ZodValidationPipe(verifyCodeSchema)) body: VerifyCodeBody) {
    return orThrow(await this.recovery.verify(this.scopes.for(tenant), body));
  }

  @Post("password")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Definir a senha", description: "Ativa a conta ou repõe a senha. Segue para a 2FA (nunca abre sessão sozinho)." })
  @ApiBody({ schema: openApi(setPasswordSchema) })
  @ApiResponse({ status: 200, description: "Falta a 2FA", schema: openApi(loginStepSchema, "output") })
  async setPassword(@CurrentTenant() tenant: TenantContext, @Body(new ZodValidationPipe(setPasswordSchema)) body: SetPasswordBody) {
    return orThrow(await this.recovery.setPassword(this.scopes.for(tenant), body));
  }

  // ================================================================ 2.º fator

  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Passo 3 — código da app (ou de recuperação)", description: "Abre a sessão e devolve o token." })
  @ApiBody({ schema: openApi(challengeCodeSchema) })
  @ApiResponse({ status: 200, description: "Sessão aberta", schema: openApi(sessionResponseSchema, "output") })
  async verifyMfa(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(challengeCodeSchema)) body: ChallengeCodeBody,
    @Client() client: ClientInfo,
  ) {
    return orThrow(await this.security.verifyLogin(this.scopes.for(tenant), body.challengeToken, body.code, client));
  }

  @Post("mfa/setup")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Configurar 2FA — gerar segredo (QR code)" })
  @ApiBody({ schema: openApi(challengeSchema) })
  @ApiResponse({ status: 200, description: "Segredo para a app", schema: openApi(mfaSetupSchema, "output") })
  async setupMfa(@CurrentTenant() tenant: TenantContext, @Body(new ZodValidationPipe(challengeSchema)) body: ChallengeBody) {
    return orThrow(await this.security.startEnrollment(this.scopes.for(tenant), body.challengeToken));
  }

  @Post("mfa/setup/confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Configurar 2FA — confirmar com o primeiro código", description: "Ativa a 2FA, devolve os códigos de recuperação e abre a sessão." })
  @ApiBody({ schema: openApi(challengeCodeSchema) })
  @ApiResponse({ status: 200, description: "2FA ativa e sessão aberta", schema: openApi(mfaConfirmResponseSchema, "output") })
  async confirmMfa(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(challengeCodeSchema)) body: ChallengeCodeBody,
    @Client() client: ClientInfo,
  ) {
    return orThrow(await this.security.confirmEnrollment(this.scopes.for(tenant), body.challengeToken, body.code, client));
  }

  // ================================================================ sessão aberta

  @Get("me")
  @SchoolAuth()
  @ApiOperation({ summary: "Perfil do utilizador autenticado" })
  @ApiResponse({ status: 401, description: "Sessão inválida, terminada, expirada ou de outro colégio", schema: error })
  async me(@CurrentTenant() tenant: TenantContext, @CurrentUser() user: SchoolAccess) {
    const profile = await this.profile.execute(this.scopes.for(tenant), user.id);
    if (!profile) throw new NotFoundException({ code: "ACCOUNT_NOT_FOUND", message: "Conta não encontrada." });
    return profile;
  }

  @Post("sign-out")
  @HttpCode(HttpStatus.NO_CONTENT)
  @SchoolAuth()
  @ApiOperation({ summary: "Sair (termina a sessão atual — o token deixa de valer)" })
  async signOut(@CurrentTenant() tenant: TenantContext, @CurrentUser() user: SchoolAccess) {
    await this.security.signOut(this.scopes.for(tenant), user.sessionId);
  }
}
