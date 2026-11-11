import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { unwrap } from "../../../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { BILLING_HTTP } from "../../../billing/presentation/http/billing.schemas";
import { DATABASE_HTTP } from "../../../databases/presentation/http/database.schemas";
import { VERIFICATION_HTTP } from "../../../verification/verification.module";
import type { StaffAccess } from "../../../identity/application/ports";
import { CurrentStaff, RequireRecentMfa, StaffAuth } from "../../../identity/presentation/http/staff-auth";
import { MAX_PROOF_BYTES, SchoolPayments } from "../../application/SchoolPayments";
import { SchoolBranding } from "../../application/SchoolBranding";
import { SchoolOnboarding } from "../../application/SchoolOnboarding";
import { LOGO_RULES } from "../../domain/logo";
import { PROVINCES } from "../../domain/school-data";
import { CurrentSchoolId, SchoolOwnerAuth } from "./school-auth";
import {
  type ApproveBody,
  approveSchema,
  emailCheckSchema,
  emailCodeVerifySchema,
  nifCheckSchema,
  ownerResetSchema,
  type PaymentMethodBody,
  paymentMethodSchema,
  proofSchema,
  reasonSchema,
  type RegisterSchoolBody,
  registerSchoolSchema,
  SCHOOL_HTTP,
  schoolStatusQuery,
  signInSchema,
} from "./school.schemas";

const MINUTE = 60_000;
const uuid = new ZodValidationPipe(registerSchoolSchema.shape.subscription.shape.planId);
/** Erros dos colégios + dos códigos por email. */
const PUBLIC_HTTP: Partial<Record<string, HttpStatus>> = { ...SCHOOL_HTTP, ...VERIFICATION_HTTP };

type Upload = { buffer: Buffer } | undefined;
/** Logótipo: um ficheiro, campo "logo". O limite real (e o tipo) é validado pelos bytes no domínio. */
const LogoUpload = () => UseInterceptors(FileInterceptor("logo", { limits: { fileSize: LOGO_RULES.MAX_BYTES, files: 1, fields: 0 } }));
const LOGO_BODY: Parameters<typeof ApiBody>[0] = {
  schema: { type: "object", required: ["logo"], properties: { logo: { type: "string", format: "binary" } } },
};
const LOGO_DESCRIPTION = `PNG, JPG ou WebP até 2 MB, entre ${LOGO_RULES.MIN_SIDE} e ${LOGO_RULES.MAX_SIDE} px de lado. Sem SVG. O ficheiro fica PÚBLICO.`;

function logoContent(file: Upload) {
  if (!file?.buffer?.length) throw new BadRequestException({ code: "INVALID_LOGO", message: "Escolha uma imagem." });
  return file.buffer;
}

// =============================================================================
//  Público — logótipos guardados nesta API (só com LOGO_STORAGE=local)
// =============================================================================
@ApiTags("Público · Registo de colégio")
@Controller("v1/public/schools/logos")
export class SchoolLogoFilesController {
  constructor(private readonly branding: SchoolBranding) {}

  @Get(":file")
  @Throttle({ default: { limit: 300, ttl: MINUTE } })
  @ApiOperation({ summary: "Logótipo de um colégio (armazenamento local)" })
  async file(@Param("file") file: string, @Res() res: Response) {
    const logo = await this.branding.logoFile(file);
    if (!logo) throw new NotFoundException({ code: "LOGO_NOT_FOUND", message: "Logótipo não encontrado." });
    res.setHeader("Content-Type", logo.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // o nome muda a cada envio → pode ficar em cache muito tempo
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(logo.content);
  }
}

// =============================================================================
//  Público — registo do colégio
// =============================================================================
@ApiTags("Público · Registo de colégio")
@Controller("v1/public/schools")
export class SchoolOnboardingController {
  constructor(private readonly onboarding: SchoolOnboarding) {}

  @Get("provinces")
  @ApiOperation({ summary: "Províncias de Angola" })
  provinces() {
    return PROVINCES;
  }

  @Post("check-email")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: "Passo 1 — o email corporativo é válido e está livre?" })
  @ApiBody({ schema: openApi(emailCheckSchema) })
  async checkEmail(@Body(new ZodValidationPipe(emailCheckSchema)) body: { email: string }) {
    return unwrap(await this.onboarding.checkEmail(body.email), SCHOOL_HTTP);
  }

  @Post("check-nif")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: "O NIF já está registado?" })
  @ApiBody({ schema: openApi(nifCheckSchema) })
  checkNif(@Body(new ZodValidationPipe(nifCheckSchema)) body: { nif: string }) {
    return this.onboarding.checkNif(body.nif);
  }

  @Post("email-code")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @ApiOperation({
    summary: "Passo 1b — enviar código para o email corporativo",
    description: "O email é confirmado antes do registo. Limites por email: 1/min, 5 por dia, 10 erros por dia.",
  })
  @ApiBody({ schema: openApi(emailCheckSchema) })
  async emailCode(@Body(new ZodValidationPipe(emailCheckSchema)) body: { email: string }) {
    return unwrap(await this.onboarding.sendSignUpCode(body.email), PUBLIC_HTTP);
  }

  @Post("email-code/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Passo 1c — confirmar o código", description: "Devolve emailProof (30 min, uso único) a enviar no registo." })
  @ApiBody({ schema: openApi(emailCodeVerifySchema) })
  async emailCodeVerify(@Body(new ZodValidationPipe(emailCodeVerifySchema)) body: { email: string; code: string }) {
    return unwrap(await this.onboarding.verifySignUpCode(body.email, body.code), PUBLIC_HTTP);
  }

  @Post("password-reset/code")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @ApiOperation({ summary: "Esqueci a senha — enviar código para o email corporativo", description: "Resposta igual se o colégio não existir." })
  @ApiBody({ schema: openApi(emailCheckSchema) })
  async resetCode(@Body(new ZodValidationPipe(emailCheckSchema)) body: { email: string }) {
    return unwrap(await this.onboarding.requestPasswordReset(body.email), PUBLIC_HTTP);
  }

  @Post("password-reset/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Esqueci a senha — confirmar o código", description: "Devolve um bilhete (30 min, uso único)." })
  @ApiBody({ schema: openApi(emailCodeVerifySchema) })
  async resetVerify(@Body(new ZodValidationPipe(emailCodeVerifySchema)) body: { email: string; code: string }) {
    return unwrap(await this.onboarding.verifyPasswordReset(body.email, body.code), PUBLIC_HTTP);
  }

  @Post("password-reset")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Esqueci a senha — definir a nova senha", description: "Devolve um token do responsável (já com sessão)." })
  @ApiBody({ schema: openApi(ownerResetSchema) })
  async resetPassword(@Body(new ZodValidationPipe(ownerResetSchema)) body: { email: string; ticket: string; password: string }) {
    return unwrap(await this.onboarding.resetPassword(body), PUBLIC_HTTP);
  }

  @Post("register")
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @ApiOperation({
    summary: "Registar colégio e pedir subscrição",
    description: "Cria o colégio (estado: por validar) e a encomenda da subscrição. Devolve um token do responsável.",
  })
  @ApiBody({ schema: openApi(registerSchoolSchema) })
  async register(@Body(new ZodValidationPipe(registerSchoolSchema)) body: RegisterSchoolBody) {
    // o registo também valida o plano (faturação) e a prova do email (verificação)
    return unwrap(await this.onboarding.register(body), { ...BILLING_HTTP, ...PUBLIC_HTTP });
  }

  @Post("sign-in")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Login do responsável do colégio" })
  @ApiBody({ schema: openApi(signInSchema) })
  async signIn(@Body(new ZodValidationPipe(signInSchema)) body: { email: string; password: string }) {
    return unwrap(await this.onboarding.signIn(body.email, body.password), SCHOOL_HTTP);
  }
}

// =============================================================================
//  Portal do colégio (responsável autenticado)
// =============================================================================
@ApiTags("Portal do colégio")
@Controller("v1/schools/me")
@SchoolOwnerAuth()
export class SchoolPortalController {
  constructor(
    private readonly payments: SchoolPayments,
    private readonly onboarding: SchoolOnboarding,
    private readonly branding: SchoolBranding,
  ) {}

  @Post("logo")
  @HttpCode(HttpStatus.OK)
  // as tentativas recusadas (imagem inválida) também contam
  @Throttle({ default: { limit: 20, ttl: 15 * MINUTE } })
  @LogoUpload()
  @ApiConsumes("multipart/form-data")
  @ApiBody(LOGO_BODY)
  @ApiOperation({ summary: "Enviar / trocar o logótipo do colégio", description: LOGO_DESCRIPTION })
  async uploadLogo(@CurrentSchoolId() schoolId: string, @UploadedFile() file: Upload) {
    unwrap(await this.branding.changeLogo(schoolId, logoContent(file), null), SCHOOL_HTTP);
    return unwrap(await this.payments.portalView(schoolId), SCHOOL_HTTP);
  }

  @Delete("logo")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @ApiOperation({ summary: "Remover o logótipo do colégio" })
  async removeLogo(@CurrentSchoolId() schoolId: string) {
    unwrap(await this.branding.removeLogo(schoolId, null), SCHOOL_HTTP);
    return unwrap(await this.payments.portalView(schoolId), SCHOOL_HTTP);
  }

  @Post("email/code")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @ApiOperation({ summary: "Trocar o email — enviar código para o novo email (corporativo)" })
  @ApiBody({ schema: openApi(emailCheckSchema) })
  async emailCode(@CurrentSchoolId() schoolId: string, @Body(new ZodValidationPipe(emailCheckSchema)) body: { email: string }) {
    return unwrap(await this.onboarding.sendEmailChangeCode(schoolId, body.email), PUBLIC_HTTP);
  }

  @Post("email")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 5 * MINUTE } })
  @ApiOperation({ summary: "Trocar o email — confirmar o código", description: "O novo email passa a ser o acesso da conta e termina o prazo do email pessoal." })
  @ApiBody({ schema: openApi(emailCodeVerifySchema) })
  async changeEmail(@CurrentSchoolId() schoolId: string, @Body(new ZodValidationPipe(emailCodeVerifySchema)) body: { email: string; code: string }) {
    unwrap(await this.onboarding.confirmEmailChange(schoolId, body.email, body.code), PUBLIC_HTTP);
    return unwrap(await this.payments.portalView(schoolId), SCHOOL_HTTP);
  }

  @Get()
  @ApiOperation({ summary: "Estado do colégio, subscrição, instruções de pagamento e histórico" })
  async me(@CurrentSchoolId() schoolId: string) {
    return unwrap(await this.payments.portalView(schoolId), SCHOOL_HTTP);
  }

  @Post("payment/proof")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @UseInterceptors(FileInterceptor("proof", { limits: { fileSize: MAX_PROOF_BYTES, files: 1 } }))
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["transactionNumber", "proof"],
      properties: { transactionNumber: { type: "string" }, proof: { type: "string", format: "binary" } },
    },
  })
  @ApiOperation({ summary: "Enviar comprovativo de transferência", description: "PDF ou imagem até 5 MB. Validação manual pela equipa." })
  async proof(
    @CurrentSchoolId() schoolId: string,
    @Body(new ZodValidationPipe(proofSchema)) body: { transactionNumber: string },
    @UploadedFile() file?: { originalname: string; mimetype: string; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException({ code: "INVALID_PROOF", message: "Anexe o comprovativo." });
    return unwrap(
      await this.payments.submitTransferProof(schoolId, {
        transactionNumber: body.transactionNumber,
        file: { fileName: file.originalname.slice(0, 120), mimeType: file.mimetype, content: file.buffer },
      }),
      SCHOOL_HTTP,
    );
  }

  @Post("payment/simulate-reference")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "SIMULAÇÃO — pagar a referência",
    description: "Ambiente de teste: simula a confirmação do gateway de pagamentos por referência.",
  })
  async simulate(@CurrentSchoolId() schoolId: string) {
    return unwrap(await this.payments.simulateReferencePayment(schoolId), SCHOOL_HTTP);
  }
}

// =============================================================================
//  Equipa EduFlow — validação de colégios e pagamentos
// =============================================================================
@ApiTags("Plataforma · Colégios")
@ApiBearerAuth()
@Controller("v1/platform/schools")
export class SchoolsAdminController {
  constructor(
    private readonly payments: SchoolPayments,
    private readonly branding: SchoolBranding,
  ) {}

  @Post(":id/logo")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @Throttle({ default: { limit: 20, ttl: 15 * MINUTE } })
  @LogoUpload()
  @ApiConsumes("multipart/form-data")
  @ApiBody(LOGO_BODY)
  @ApiOperation({ summary: "Enviar / trocar o logótipo de um colégio", description: LOGO_DESCRIPTION })
  async uploadLogo(@Param("id", uuid) id: string, @UploadedFile() file: Upload, @CurrentStaff() staff: StaffAccess) {
    unwrap(await this.branding.changeLogo(id, logoContent(file), staff.id), SCHOOL_HTTP);
    return unwrap(await this.payments.detail(id), SCHOOL_HTTP);
  }

  @Delete(":id/logo")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @ApiOperation({ summary: "Remover o logótipo de um colégio" })
  async removeLogo(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    unwrap(await this.branding.removeLogo(id, staff.id), SCHOOL_HTTP);
    return unwrap(await this.payments.detail(id), SCHOOL_HTTP);
  }

  @Get()
  @StaffAuth("schools.view")
  @ApiOperation({ summary: "Listar colégios (com contagens por estado)" })
  list(@Query(new ZodValidationPipe(schoolStatusQuery)) query: { status?: "PENDING_REVIEW" }) {
    return this.payments.list(query.status);
  }

  @Get(":id")
  @StaffAuth("schools.view")
  @ApiOperation({ summary: "Detalhe do colégio, subscrição e histórico" })
  async detail(@Param("id", uuid) id: string) {
    return unwrap(await this.payments.detail(id), SCHOOL_HTTP);
  }

  @Post(":id/approve")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @ApiOperation({
    summary: "Validar pedido, definir a forma de pagamento e reservar servidor de BD",
    description: "A reserva tem prazo; a BD só passa a ser do colégio quando o pagamento for confirmado.",
  })
  @ApiBody({ schema: openApi(approveSchema) })
  async approve(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(approveSchema)) body: ApproveBody,
    @CurrentStaff() staff: StaffAccess,
  ) {
    const statuses: Partial<Record<string, HttpStatus>> = { ...DATABASE_HTTP, ...SCHOOL_HTTP };
    return unwrap(await this.payments.approve(id, staff.id, body), statuses);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @ApiOperation({ summary: "Rejeitar pedido" })
  @ApiBody({ schema: openApi(reasonSchema) })
  async reject(@Param("id", uuid) id: string, @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string }, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.payments.reject(id, staff.id, body.reason), SCHOOL_HTTP);
  }

  @Post(":id/suspend")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @RequireRecentMfa()
  @ApiOperation({ summary: "Desativar colégio (2FA recente)", description: "O portal do colégio deixa de estar acessível (≤ 60 s). Os dados ficam guardados." })
  @ApiBody({ schema: openApi(reasonSchema) })
  async suspend(@Param("id", uuid) id: string, @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string }, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.payments.suspend(id, staff.id, body.reason), SCHOOL_HTTP);
  }

  @Post(":id/reactivate")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @RequireRecentMfa()
  @ApiOperation({
    summary: "Reativar colégio desativado (2FA recente)",
    description: "Volta ao estado anterior. Se ainda usa email pessoal com o prazo passado, recebe um novo prazo de 30 dias.",
  })
  async reactivate(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.payments.reactivate(id, staff.id), SCHOOL_HTTP);
  }

  @Post(":id/payment-method")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Alterar a forma de pagamento (ex.: referência expirada)" })
  @ApiBody({ schema: openApi(paymentMethodSchema) })
  async paymentMethod(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(paymentMethodSchema)) body: PaymentMethodBody,
    @CurrentStaff() staff: StaffAccess,
  ) {
    return unwrap(await this.payments.changePaymentMethod(id, staff.id, body), SCHOOL_HTTP);
  }

  @Post(":id/payment/confirm")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Confirmar transferência (após verificar com o banco)" })
  async confirm(@Param("id", uuid) id: string, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.payments.confirmTransfer(id, staff.id), SCHOOL_HTTP);
  }

  @Post(":id/payment/reject-proof")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Rejeitar comprovativo" })
  @ApiBody({ schema: openApi(reasonSchema) })
  async rejectProof(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
    @CurrentStaff() staff: StaffAccess,
  ) {
    return unwrap(await this.payments.rejectProof(id, staff.id, body.reason), SCHOOL_HTTP);
  }

  @Get(":id/payment/proof")
  @StaffAuth("billing.view")
  @ApiOperation({ summary: "Descarregar comprovativo" })
  async proof(@Param("id", uuid) id: string, @Res() res: Response) {
    const file = unwrap(await this.payments.proofFile(id), SCHOOL_HTTP);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.fileName)}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(file.content);
  }
}
