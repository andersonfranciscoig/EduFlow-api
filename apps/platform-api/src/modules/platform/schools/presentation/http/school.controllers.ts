import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import type { StaffAccess } from "../../../identity/application/ports";
import { CurrentStaff, StaffAuth } from "../../../identity/presentation/http/staff-auth";
import { MAX_PROOF_BYTES, SchoolPayments } from "../../application/SchoolPayments";
import { SchoolOnboarding } from "../../application/SchoolOnboarding";
import { PROVINCES } from "../../domain/school-data";
import { CurrentSchoolId, SchoolOwnerAuth } from "./school-auth";
import {
  emailCheckSchema,
  nifCheckSchema,
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

  @Post("register")
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE } })
  @ApiOperation({
    summary: "Registar colégio e pedir subscrição",
    description: "Cria o colégio (estado: por validar) e a encomenda da subscrição. Devolve um token do responsável.",
  })
  @ApiBody({ schema: openApi(registerSchoolSchema) })
  async register(@Body(new ZodValidationPipe(registerSchoolSchema)) body: RegisterSchoolBody) {
    // o registo também valida o plano (erros do contexto de faturação)
    const statuses: Partial<Record<string, HttpStatus>> = { ...BILLING_HTTP, ...SCHOOL_HTTP };
    return unwrap(await this.onboarding.register(body), statuses);
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
  constructor(private readonly payments: SchoolPayments) {}

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
  constructor(private readonly payments: SchoolPayments) {}

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
  @ApiOperation({ summary: "Validar pedido e definir a forma de pagamento" })
  @ApiBody({ schema: openApi(paymentMethodSchema) })
  async approve(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(paymentMethodSchema)) body: PaymentMethodBody,
    @CurrentStaff() staff: StaffAccess,
  ) {
    return unwrap(await this.payments.approve(id, staff.id, body), SCHOOL_HTTP);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @StaffAuth("schools.manage")
  @ApiOperation({ summary: "Rejeitar pedido" })
  @ApiBody({ schema: openApi(reasonSchema) })
  async reject(@Param("id", uuid) id: string, @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string }, @CurrentStaff() staff: StaffAccess) {
    return unwrap(await this.payments.reject(id, staff.id, body.reason), SCHOOL_HTTP);
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
