import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { apiErrorSchema, openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import type { ClientInfo, StaffAccess } from "../../application/ports";
import { AuthenticateStaffMember } from "../../application/use-cases/AuthenticateStaffMember";
import { GetStaffProfile } from "../../application/use-cases/GetStaffProfile";
import { IdentifyStaffMember } from "../../application/use-cases/IdentifyStaffMember";
import { RegisterStaffMember } from "../../application/use-cases/RegisterStaffMember";
import { StaffSecurity } from "../../application/use-cases/StaffSecurity";
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
  securitySchema,
  sessionIdSchema,
  sessionResponseSchema,
  type SignInBody,
  signInSchema,
  type SignUpBody,
  signUpResponseSchema,
  signUpSchema,
  type StepUpBody,
  stepUpSchema,
} from "./auth.schemas";
import { Client } from "./client-info";
import { toHttpException } from "./identity-http-error";
import { CurrentStaff, RequireRecentMfa, StaffAuth } from "./staff-auth";
import { staffDetailSchema } from "./staff.schemas";

const MINUTE = 60_000;
const error = openApi(apiErrorSchema);
const tooMany = { status: 429, description: "Demasiados pedidos — aguarde e tente de novo" };

/**
 * Autenticação da equipa interna EduFlow — sempre com 2 fatores:
 *   identify → sign-in (senha) → mfa/verify (código)   ou
 *                              → mfa/setup → mfa/setup/confirm (primeira vez)
 * Só depois da 2FA é aberta uma sessão e emitido o token de acesso.
 */
@ApiTags("Plataforma · Autenticação")
@Controller("v1/platform/auth")
export class AuthController {
  constructor(
    private readonly identifyStaff: IdentifyStaffMember,
    private readonly registerStaff: RegisterStaffMember,
    private readonly authenticateStaff: AuthenticateStaffMember,
    private readonly getProfile: GetStaffProfile,
    private readonly security: StaffSecurity,
  ) {}

  // ================================================================ 1.º fator

  @Post("identify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: "Passo 1 — identificar a conta" })
  @ApiBody({ schema: openApi(identifySchema) })
  @ApiResponse({ status: 200, description: "Resultado da identificação", schema: openApi(identifyResponseSchema, "output") })
  @ApiResponse({ status: 422, description: "Email ou telefone inválido", schema: error })
  async identify(@Body(new ZodValidationPipe(identifySchema)) body: IdentifyBody) {
    const result = await this.identifyStaff.execute(body);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post("sign-in")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({
    summary: "Passo 2 — senha",
    description: "Senha certa → devolve um bilhete para a 2FA (verificar código, ou configurar na primeira vez). Ainda não dá acesso.",
  })
  @ApiBody({ schema: openApi(signInSchema) })
  @ApiResponse({ status: 200, description: "Falta a 2FA", schema: openApi(loginStepSchema, "output") })
  @ApiResponse({ status: 401, description: "Credenciais inválidas", schema: error })
  @ApiResponse({ status: 423, description: "Conta temporariamente bloqueada", schema: error })
  @ApiResponse(tooMany)
  async signIn(@Body(new ZodValidationPipe(signInSchema)) body: SignInBody) {
    const result = await this.authenticateStaff.execute(body);
    if (!result.ok) throw toHttpException(result.error);
    const step = await this.security.afterPassword(result.value);
    return { ...step, firstName: result.value.fullName.split(" ")[0] };
  }

  @Post("sign-up")
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @ApiOperation({
    summary: "Criar conta da equipa",
    description: "O primeiro membro torna-se ADMIN e segue para a configuração da 2FA. Os seguintes aguardam aprovação.",
  })
  @ApiBody({ schema: openApi(signUpSchema) })
  @ApiResponse({ status: 201, description: "Conta criada", schema: openApi(signUpResponseSchema, "output") })
  @ApiResponse({ status: 409, description: "Já existe uma conta com este identificador", schema: error })
  @ApiResponse(tooMany)
  async signUp(@Body(new ZodValidationPipe(signUpSchema)) body: SignUpBody) {
    const result = await this.registerStaff.execute(body);
    if (!result.ok) throw toHttpException(result.error);
    const { principal, role, status } = result.value;
    const firstName = principal.fullName.split(" ")[0];
    if (status !== "ACTIVE") return { role, status, firstName };
    const step = await this.security.afterPassword({ id: principal.id, mfaEnabled: false });
    return { role, status: step.status, challengeToken: step.challengeToken, firstName };
  }

  // ================================================================ 2.º fator

  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Passo 3 — código da app (ou de recuperação)", description: "Abre a sessão e devolve o token." })
  @ApiBody({ schema: openApi(challengeCodeSchema) })
  @ApiResponse({ status: 200, description: "Sessão aberta", schema: openApi(sessionResponseSchema, "output") })
  @ApiResponse({ status: 401, description: "Código incorreto ou bilhete expirado", schema: error })
  @ApiResponse(tooMany)
  async verify(@Body(new ZodValidationPipe(challengeCodeSchema)) body: ChallengeCodeBody, @Client() client: ClientInfo) {
    const result = await this.security.verifyLogin(body.challengeToken, body.code, client);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post("mfa/setup")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Configurar 2FA — gerar segredo (QR code)" })
  @ApiBody({ schema: openApi(challengeSchema) })
  @ApiResponse({ status: 200, description: "Segredo para a app", schema: openApi(mfaSetupSchema, "output") })
  async setup(@Body(new ZodValidationPipe(challengeSchema)) body: ChallengeBody) {
    const result = await this.security.startEnrollment(body.challengeToken);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post("mfa/setup/confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Configurar 2FA — confirmar com o primeiro código", description: "Ativa a 2FA, devolve os códigos de recuperação e abre a sessão." })
  @ApiBody({ schema: openApi(challengeCodeSchema) })
  @ApiResponse({ status: 200, description: "2FA ativa e sessão aberta", schema: openApi(mfaConfirmResponseSchema, "output") })
  async confirmSetup(@Body(new ZodValidationPipe(challengeCodeSchema)) body: ChallengeCodeBody, @Client() client: ClientInfo) {
    const result = await this.security.confirmEnrollment(body.challengeToken, body.code, client);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Post("mfa/step-up")
  @HttpCode(HttpStatus.NO_CONTENT)
  @StaffAuth()
  @ApiBearerAuth()
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Confirmar identidade para ações sensíveis", description: "Válido por 10 minutos nesta sessão." })
  @ApiBody({ schema: openApi(stepUpSchema) })
  async stepUp(@Body(new ZodValidationPipe(stepUpSchema)) body: StepUpBody, @CurrentStaff() staff: StaffAccess) {
    const result = await this.security.stepUp(staff.id, staff.sessionId, body.code);
    if (!result.ok) throw toHttpException(result.error);
  }

  @Post("mfa/recovery-codes")
  @HttpCode(HttpStatus.OK)
  @StaffAuth()
  @RequireRecentMfa()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Gerar novos códigos de recuperação", description: "Os anteriores deixam de valer. Exige 2FA recente." })
  async regenerateRecoveryCodes(@CurrentStaff() staff: StaffAccess) {
    const result = await this.security.regenerateRecoveryCodes(staff.id);
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  // ================================================================ conta e sessões

  @Get("me")
  @StaffAuth()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Perfil do membro autenticado" })
  @ApiResponse({ status: 200, description: "Perfil", schema: openApi(staffDetailSchema, "output") })
  @ApiResponse({ status: 401, description: "Sessão inválida, terminada ou expirada", schema: error })
  async me(@CurrentStaff() staff: StaffAccess) {
    const result = await this.getProfile.execute({ id: staff.id });
    if (!result.ok) throw toHttpException(result.error);
    return result.value;
  }

  @Get("security")
  @StaffAuth()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Segurança da conta: 2FA e sessões ativas" })
  @ApiResponse({ status: 200, description: "Estado", schema: openApi(securitySchema, "output") })
  async mySecurity(@CurrentStaff() staff: StaffAccess) {
    const [status, sessions] = await Promise.all([this.security.status(staff.id), this.security.listSessions(staff.id, staff.sessionId)]);
    return { ...status, sessions };
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @StaffAuth()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Terminar uma das minhas sessões" })
  async revokeSession(@Param("id", new ZodValidationPipe(sessionIdSchema)) id: string, @CurrentStaff() staff: StaffAccess) {
    const result = await this.security.revokeOwnSession(staff.id, id);
    if (!result.ok) throw toHttpException(result.error);
  }

  @Post("sessions/revoke-others")
  @HttpCode(HttpStatus.OK)
  @StaffAuth()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Terminar todas as outras sessões" })
  revokeOthers(@CurrentStaff() staff: StaffAccess) {
    return this.security.revokeOtherSessions(staff.id, staff.sessionId);
  }

  @Post("sign-out")
  @HttpCode(HttpStatus.NO_CONTENT)
  @StaffAuth()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Sair (termina a sessão atual — o token deixa de valer)" })
  async signOut(@CurrentStaff() staff: StaffAccess) {
    await this.security.signOut(staff.sessionId);
  }
}
