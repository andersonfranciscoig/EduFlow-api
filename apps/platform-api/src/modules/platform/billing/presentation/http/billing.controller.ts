import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { unwrap } from "../../../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { StaffAuth } from "../../../identity/presentation/http/staff-auth";
import { BillingService } from "../../application/BillingService";
import {
  BILLING_HTTP,
  type BankAccountBody,
  bankAccountSchema,
  type PlanBody,
  planSchema,
  type QuoteBody,
  quoteSchema,
  type SettingsBody,
  settingsSchema,
  uuidSchema,
} from "./billing.schemas";

const id = new ZodValidationPipe(uuidSchema);

/** Rotas públicas usadas no registo do colégio. */
@ApiTags("Público · Planos")
@Controller("v1/public/billing")
export class PublicBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get("plans")
  @ApiOperation({ summary: "Planos disponíveis e descontos por periodicidade" })
  plans() {
    return this.billing.publicCatalog();
  }

  @Post("quote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Calcular o valor de uma subscrição", description: "Plano + periodicidade (incl. personalizada)." })
  @ApiBody({ schema: openApi(quoteSchema) })
  async quote(@Body(new ZodValidationPipe(quoteSchema)) body: QuoteBody) {
    return unwrap(await this.billing.quote(body.planId, body.cycle), BILLING_HTTP);
  }
}

/** Gestão da faturação pela equipa EduFlow. */
@ApiTags("Plataforma · Faturação")
@ApiBearerAuth()
@Controller("v1/platform/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  // ------------------------------------------------------------------ definições
  @Get("settings")
  @StaffAuth("billing.view")
  @ApiOperation({ summary: "Definições de faturação" })
  settings() {
    return this.billing.getSettings();
  }

  @Put("settings")
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Atualizar definições (descontos, referência, transferência)" })
  @ApiBody({ schema: openApi(settingsSchema) })
  async updateSettings(@Body(new ZodValidationPipe(settingsSchema)) body: SettingsBody) {
    return unwrap(await this.billing.updateSettings(body), BILLING_HTTP);
  }

  // ------------------------------------------------------------------ planos
  @Get("plans")
  @StaffAuth("billing.view")
  @ApiOperation({ summary: "Todos os planos (incl. inativos)" })
  plans() {
    return this.billing.listPlans();
  }

  @Post("plans")
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Criar plano" })
  @ApiBody({ schema: openApi(planSchema) })
  async createPlan(@Body(new ZodValidationPipe(planSchema)) body: PlanBody) {
    return unwrap(await this.billing.createPlan(body), BILLING_HTTP);
  }

  @Put("plans/:id")
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Atualizar plano" })
  @ApiBody({ schema: openApi(planSchema) })
  async updatePlan(@Param("id", id) planId: string, @Body(new ZodValidationPipe(planSchema)) body: PlanBody) {
    return unwrap(await this.billing.updatePlan(planId, body), BILLING_HTTP);
  }

  // ------------------------------------------------------------------ contas bancárias
  @Get("bank-accounts")
  @StaffAuth("billing.view")
  @ApiOperation({ summary: "Contas bancárias para transferências" })
  bankAccounts() {
    return this.billing.listBankAccounts();
  }

  @Post("bank-accounts")
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Adicionar conta bancária", description: "O IBAN é validado (mod-97)." })
  @ApiBody({ schema: openApi(bankAccountSchema) })
  async createBankAccount(@Body(new ZodValidationPipe(bankAccountSchema)) body: BankAccountBody) {
    return unwrap(await this.billing.createBankAccount(body), BILLING_HTTP);
  }

  @Put("bank-accounts/:id")
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Atualizar conta bancária" })
  @ApiBody({ schema: openApi(bankAccountSchema) })
  async updateBankAccount(@Param("id", id) accountId: string, @Body(new ZodValidationPipe(bankAccountSchema)) body: BankAccountBody) {
    return unwrap(await this.billing.updateBankAccount(accountId, body), BILLING_HTTP);
  }

  @Delete("bank-accounts/:id")
  @StaffAuth("billing.manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remover conta bancária" })
  async deleteBankAccount(@Param("id", id) accountId: string) {
    unwrap(await this.billing.deleteBankAccount(accountId), BILLING_HTTP);
  }
}
