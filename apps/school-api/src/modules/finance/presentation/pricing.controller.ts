import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import type { FinanceActor } from "../application/ports";
import { Pricing } from "../application/Pricing";
import type { FinanceErrorCode } from "../domain/pricing";
import { PrismaPricingRepository } from "../infrastructure/prisma-pricing";

export const FINANCE_HTTP: Partial<Record<FinanceErrorCode, HttpStatus>> = {
  FORBIDDEN: HttpStatus.FORBIDDEN,
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  YEAR_NOT_FOUND: HttpStatus.NOT_FOUND,
  YEAR_CLOSED: HttpStatus.CONFLICT,
  CLASS_NOT_FOUND: HttpStatus.NOT_FOUND,
  FEE_ITEM_NOT_FOUND: HttpStatus.NOT_FOUND,
  FEE_ITEM_EXISTS: HttpStatus.CONFLICT,
  FEE_ITEM_IN_USE: HttpStatus.CONFLICT,
  FEE_ITEM_ARCHIVED: HttpStatus.CONFLICT,
  FEE_ITEM_LIMIT: HttpStatus.CONFLICT,
};

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const feeItemBody = z
  .object({ name: z.string().min(2).max(40), billing: z.enum(["MENSAL", "UNICA"]), appliesTo: z.enum(["TODOS", "NOVOS", "CONTINUANTES"]).nullish() })
  .meta({ title: "FeeItem", description: "Rubrica de cobrança: nome, mensal ou única, e a quem se aplica (todos, alunos novos, alunos que continuam)." });
const amount = z
  .number({ error: "Indique o valor em kwanzas." })
  .int({ error: "Os valores são em kwanzas, sem casas decimais." })
  .min(0, { error: "O valor não pode ser negativo." })
  .max(100_000_000, { error: "O valor máximo é 100 000 000 Kz." });
const pricesBody = z
  .object({ items: z.array(z.object({ classId: z.uuid(), feeItemId: z.uuid(), amount: amount.nullable() })).min(1, { error: "Nada para gravar." }).max(600) })
  .meta({ title: "Prices", description: "Preços a gravar (kwanzas). amount null = retirar o preço. Só o que vem na lista muda." });
const copyBody = z
  .object({ fromYearId: z.uuid(), overwrite: z.boolean().default(false) })
  .meta({ title: "PricesCopy", description: "Copia os preços de outro ano para as classes equivalentes (mesma classe e curso). Sem overwrite, só preenche o que está vazio." });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mês no formato AAAA-MM.");
const planBody = z
  .object({
    months: z.array(month).min(1, { error: "Escolha pelo menos um mês de propina." }).max(24),
    dueDay: z.number().int().min(1, { error: "O dia limite vai de 1 a 28." }).max(28, { error: "O dia limite vai de 1 a 28." }),
    lateFee: z.object({
      kind: z.enum(["NONE", "PERCENT", "FIXED"], { error: "Tipo de multa inválido." }),
      value: z.number().int({ error: "A multa é um número inteiro." }).min(0).max(10_000_000, { error: "A multa fixa vai até 10 000 000 Kz." }),
    }),
  })
  .meta({ title: "FeePlan", description: "Calendário das propinas: meses cobrados (dentro do ano letivo), dia limite (1–28) e multa por atraso." });

const actorOf = (u: SchoolAccess): FinanceActor => ({ id: u.id, role: u.role, isOwner: u.isOwner, support: u.support ? { mode: u.support.mode } : undefined });

/**
 * Preçário do colégio: rubricas, preço por classe (e curso, no II Ciclo) e calendário das propinas.
 * Ver: qualquer utilizador do colégio. Alterar: direção (o suporte em só leitura é travado no guard).
 */
@ApiTags("Portal · Finanças · Preçário")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/finance")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class PricingController {
  constructor(private readonly pricing: Pricing) {}

  private repo(tenant: TenantContext) {
    return new PrismaPricingRepository(tenant.db);
  }

  // ---------------------------------------------------------------- rubricas

  @Get("fee-items")
  @ApiOperation({ summary: "Rubricas de cobrança (com o nº de preços definidos)" })
  feeItems(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    return this.pricing.listFeeItems(this.repo(t), actorOf(u));
  }

  @Post("fee-items")
  @ApiOperation({ summary: "Criar rubrica" })
  @ApiBody({ schema: openApi(feeItemBody) })
  async createFeeItem(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(feeItemBody)) body: z.infer<typeof feeItemBody>) {
    return unwrap(await this.pricing.createFeeItem(this.repo(t), actorOf(u), body), FINANCE_HTTP);
  }

  @Patch("fee-items/:id")
  @ApiOperation({ summary: "Alterar rubrica" })
  @ApiBody({ schema: openApi(feeItemBody) })
  async updateFeeItem(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) feeItemId: string, @Body(new ZodValidationPipe(feeItemBody)) body: z.infer<typeof feeItemBody>) {
    return unwrap(await this.pricing.updateFeeItem(this.repo(t), actorOf(u), feeItemId, body), FINANCE_HTTP);
  }

  @Post("fee-items/:id/archive")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Arquivar rubrica (mantém os preços que já tem; não ganha novos)" })
  async archiveFeeItem(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) feeItemId: string) {
    return unwrap(await this.pricing.setFeeItemArchived(this.repo(t), actorOf(u), feeItemId, true), FINANCE_HTTP);
  }

  @Post("fee-items/:id/restore")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reativar rubrica" })
  async restoreFeeItem(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) feeItemId: string) {
    return unwrap(await this.pricing.setFeeItemArchived(this.repo(t), actorOf(u), feeItemId, false), FINANCE_HTTP);
  }

  @Delete("fee-items/:id")
  @ApiOperation({ summary: "Eliminar rubrica (só sem preços em nenhum ano)" })
  async deleteFeeItem(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) feeItemId: string) {
    return unwrap(await this.pricing.deleteFeeItem(this.repo(t), actorOf(u), feeItemId), FINANCE_HTTP);
  }

  // ---------------------------------------------------------------- preçário do ano

  @Get("years/:id/pricing")
  @ApiOperation({ summary: "Preçário do ano: rubricas, calendário das propinas e preços de cada classe/curso (com totais anuais)" })
  async yearPricing(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string) {
    return unwrap(await this.pricing.yearPricing(this.repo(t), actorOf(u), yearId), FINANCE_HTTP);
  }

  @Put("years/:id/pricing")
  @ApiOperation({ summary: "Gravar preços (vários de uma vez)", description: "409 YEAR_CLOSED, FEE_ITEM_ARCHIVED (rubrica arquivada não ganha preços novos)." })
  @ApiBody({ schema: openApi(pricesBody) })
  async setPrices(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(pricesBody)) body: z.infer<typeof pricesBody>) {
    return unwrap(await this.pricing.setPrices(this.repo(t), actorOf(u), yearId, body.items), FINANCE_HTTP);
  }

  @Post("years/:id/pricing/copy")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Copiar preços de outro ano letivo" })
  @ApiBody({ schema: openApi(copyBody) })
  async copyPrices(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(copyBody)) body: z.infer<typeof copyBody>) {
    return unwrap(await this.pricing.copyPrices(this.repo(t), actorOf(u), yearId, body.fromYearId, body.overwrite), FINANCE_HTTP);
  }

  @Put("years/:id/fee-plan")
  @ApiOperation({ summary: "Definir o calendário das propinas do ano (meses, dia limite, multa)" })
  @ApiBody({ schema: openApi(planBody) })
  async setFeePlan(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) yearId: string, @Body(new ZodValidationPipe(planBody)) body: z.infer<typeof planBody>) {
    return unwrap(await this.pricing.setFeePlan(this.repo(t), actorOf(u), yearId, body), FINANCE_HTTP);
  }
}
