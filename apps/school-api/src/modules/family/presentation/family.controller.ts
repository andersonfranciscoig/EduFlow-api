import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { ClientInfo } from "../../identity/application/ports";
import { Client } from "../../identity/presentation/http/http-support";
import { FamilyAuth } from "../application/FamilyAuth";
import { FamilyHome } from "../application/FamilyHome";
import type { FamilyErrorCode } from "../domain/family";
import { PrismaFamilyRepository } from "../infrastructure/prisma-family";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "./family-auth";

export const FAMILY_HTTP: Partial<Record<FamilyErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  ACCOUNT_LOCKED: HttpStatus.LOCKED,
  ACCOUNT_SUSPENDED: HttpStatus.FORBIDDEN,
  EMAIL_CODE_EXPIRED: HttpStatus.GONE,
  INVALID_EMAIL_CODE: HttpStatus.UNAUTHORIZED,
  EMAIL_CODE_COOLDOWN: HttpStatus.TOO_MANY_REQUESTS,
  EMAIL_CODE_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  EMAIL_NOT_SENT: HttpStatus.BAD_GATEWAY,
  INVALID_CHALLENGE: HttpStatus.UNAUTHORIZED,
  STUDENT_NOT_FOUND: HttpStatus.NOT_FOUND,
  UNDER_AGE: HttpStatus.UNPROCESSABLE_ENTITY,
};

const MINUTE = 60_000;
const email = z.string().max(254);
const registerBody = z
  .object({
    // validado no domínio (mensagem em português): GUARDIAN | STUDENT
    kind: z.string().max(20).default("").meta({ description: "GUARDIAN = encarregado de educação · STUDENT = aluno maior de idade" }),
    birthDate: z.string().max(10).nullish().meta({ description: "AAAA-MM-DD — obrigatória para STUDENT (o servidor confirma os 18 anos)" }),
    fullName: z.string().max(120),
    email,
    phone: z.string().max(30).nullish(),
    password: z.string().max(128),
  })
  .meta({ title: "FamilyRegister", description: "Criar conta da área da família (encarregado ou aluno maior). Segue um código por email." });
const activateBody = z.object({ email, code: z.string().max(12) }).meta({ title: "FamilyActivate" });
const emailBody = z.object({ email }).meta({ title: "FamilyEmail" });
const loginBody = z.object({ email, password: z.string().max(128) }).meta({ title: "FamilyLogin" });
const challengeBody = z.object({ challengeToken: z.string().max(2000) }).meta({ title: "FamilyChallenge" });
const verifyBody = z.object({ challengeToken: z.string().max(2000), code: z.string().max(12) }).meta({ title: "FamilyLoginVerify" });
const resetBody = z.object({ email, code: z.string().max(12), password: z.string().max(128) }).meta({ title: "FamilyReset" });
const profileBody = z.object({ fullName: z.string().max(120), phone: z.string().max(30).nullish() }).meta({ title: "FamilyProfile" });
const readBody = z.object({ ids: z.array(z.uuid()).max(200).optional() }).meta({ title: "FamilyNotificationsRead", description: "Sem ids: marca todas." });
const handoverBody = z.object({ email }).meta({ title: "FamilyHandover", description: "O email do aluno (é com ele que vai criar a conta de aluno maior)." });

const school = (t: TenantContext) => ({ id: t.entry.schoolId, name: t.entry.schoolName, slug: t.entry.slug });
const repo = (t: TenantContext) => new PrismaFamilyRepository(t.db);

/**
 * Área da família · autenticação (pública). Contas à parte das da equipa:
 *   register → activate (código) → sessão
 *   login (email + senha) → login/verify (código por email) → sessão
 *   recover → reset (código + nova senha)
 */
@ApiTags("Área da família · Autenticação")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/family/auth")
@UseGuards(TenantGuard)
export class FamilyAuthController {
  constructor(private readonly auth: FamilyAuth) {}

  @Post("register")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Criar conta", description: "A resposta é igual exista ou não já uma conta com o email (quem já tem conta recebe um aviso por email)." })
  @ApiBody({ schema: openApi(registerBody) })
  async register(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(registerBody)) body: z.infer<typeof registerBody>) {
    return unwrap(await this.auth.register(repo(t), school(t), body), FAMILY_HTTP);
  }

  @Post("activate")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Ativar a conta com o código do email (abre a sessão)" })
  @ApiBody({ schema: openApi(activateBody) })
  async activate(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(activateBody)) body: z.infer<typeof activateBody>, @Client() client: ClientInfo) {
    return unwrap(await this.auth.activate(repo(t), school(t), body, client), FAMILY_HTTP);
  }

  @Post("activate/resend")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Reenviar o código de ativação" })
  @ApiBody({ schema: openApi(emailBody) })
  async resendActivation(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(emailBody)) body: z.infer<typeof emailBody>) {
    return unwrap(await this.auth.resendActivation(repo(t), school(t), body), FAMILY_HTTP);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Entrar (email + senha) → código por email", description: "step CODE (challengeToken) ou ACTIVATE (conta por ativar: novo código de ativação). 5 erros seguidos bloqueiam 15 min." })
  @ApiBody({ schema: openApi(loginBody) })
  async login(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(loginBody)) body: z.infer<typeof loginBody>) {
    return unwrap(await this.auth.login(repo(t), school(t), body), FAMILY_HTTP);
  }

  @Post("login/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Concluir a entrada com o código do email" })
  @ApiBody({ schema: openApi(verifyBody) })
  async verify(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(verifyBody)) body: z.infer<typeof verifyBody>, @Client() client: ClientInfo) {
    return unwrap(await this.auth.verifyLogin(repo(t), school(t), body, client), FAMILY_HTTP);
  }

  @Post("login/resend")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Reenviar o código de entrada" })
  @ApiBody({ schema: openApi(challengeBody) })
  async resendLogin(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(challengeBody)) body: z.infer<typeof challengeBody>) {
    return unwrap(await this.auth.resendLogin(repo(t), school(t), body), FAMILY_HTTP);
  }

  @Post("recover")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Pedir código para repor a senha", description: "Resposta igual exista ou não a conta (destination null)." })
  @ApiBody({ schema: openApi(emailBody) })
  async recover(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(emailBody)) body: z.infer<typeof emailBody>) {
    return unwrap(await this.auth.recover(repo(t), school(t), body), FAMILY_HTTP);
  }

  @Post("reset")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 10 * MINUTE } })
  @ApiOperation({ summary: "Nova senha com o código (termina todas as sessões)" })
  @ApiBody({ schema: openApi(resetBody) })
  async reset(@CurrentTenant() t: TenantContext, @Body(new ZodValidationPipe(resetBody)) body: z.infer<typeof resetBody>) {
    return unwrap(await this.auth.resetPassword(repo(t), body), FAMILY_HTTP);
  }
}

/** Área da família · a conta (com sessão da família). */
@ApiTags("Área da família")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyController {
  constructor(
    private readonly auth: FamilyAuth,
    private readonly home: FamilyHome,
  ) {}

  @Get("me")
  @ApiOperation({ summary: "A conta: dados, se é aluno (titular), se é encarregado e os educandos menores que gere" })
  me(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.home.me(repo(t), f.account);
  }

  @Patch("me")
  @ApiOperation({ summary: "Alterar o nome e o telefone da conta" })
  @ApiBody({ schema: openApi(profileBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(profileBody)) body: z.infer<typeof profileBody>) {
    return unwrap(await this.home.updateProfile(repo(t), f.account, body), FAMILY_HTTP);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sair (termina esta sessão)" })
  logout(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.auth.logout(repo(t), f.sessionId, f.account.id);
  }

  @Get("notifications")
  @ApiOperation({ summary: "Notificações da conta (as mais recentes) e quantas estão por ler" })
  notifications(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.home.notifications(repo(t), f.account);
  }

  @Post("notifications/read")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Marcar notificações como lidas (as indicadas, ou todas)" })
  @ApiBody({ schema: openApi(readBody) })
  read(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(readBody)) body: z.infer<typeof readBody>) {
    return this.home.markRead(repo(t), f.account, body.ids);
  }

  @Post("students/:id/handover")
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({
    summary: "Passar a conta ao aluno que fez 18 anos",
    description: "O encarregado que o geria envia um convite para o email do aluno. Quando o aluno cria (ou entra com) a conta de aluno maior com esse email e a mesma data de nascimento, o registo passa a ser dele.",
  })
  @ApiBody({ schema: openApi(handoverBody) })
  async handover(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", new ParseUUIDPipe({ version: "4" })) studentId: string, @Body(new ZodValidationPipe(handoverBody)) body: z.infer<typeof handoverBody>) {
    return unwrap(await this.home.inviteHandover(repo(t), school(t), f.account, studentId, body.email), FAMILY_HTTP);
  }
}
