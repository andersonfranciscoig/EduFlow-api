import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import { sendFile } from "../../hr/presentation/employees.controller";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { type ExpenseActor, Expenses } from "../application/Expenses";
import { PROOF_MAX_MB } from "../domain/payments";
import { PrismaExpensesRepository } from "../infrastructure/prisma-expenses";
import { PAYMENTS_HTTP } from "./payments.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const expenseBody = z
  .object({
    categoryId: z.uuid({ error: "Escolha a categoria." }),
    description: z.string().max(200),
    supplier: z.string().max(200).nullish(),
    documentNumber: z.string().max(100).nullish(),
    amount: z.number().int(),
    issuedOn: day,
    dueOn: day.nullish(),
    note: z.string().max(400).nullish(),
    confirm: z.boolean().nullish(),
  })
  .meta({ title: "Expense", description: "Despesa em kwanzas; confirm = já se confirmou que não é repetida." });
const payBody = z.object({ paidOn: day, method: z.string().max(20), bankAccountId: z.uuid().nullish(), transactionNumber: z.string().max(100).nullish() }).meta({ title: "ExpensePayment" });
const reasonBody = z.object({ reason: z.string().max(400) }).meta({ title: "ExpenseReason" });
const categoriesBody = z.object({ names: z.array(z.string().max(80)).min(1).max(40) }).meta({ title: "ExpenseCategories" });
const nameBody = z.object({ name: z.string().max(80) }).meta({ title: "ExpenseCategoryName" });
const query = new ZodValidationPipe(
  z.object({ estado: z.string().max(20).optional(), categoria: z.uuid().optional(), mes: z.string().regex(/^\d{4}-\d{2}$/).optional(), q: z.string().max(80).optional(), pagina: z.coerce.number().int().min(1).max(5000).optional() }),
);
const repo = (t: TenantContext) => new PrismaExpensesRepository(t.db);
async function actorOf(t: TenantContext, u: SchoolAccess): Promise<ExpenseActor> {
  return { id: u.id, canManage: (await permissionsOf(t.db, u)).includes("finance.expenses.manage") };
}

/** Despesas do colégio. Ver: finance.expenses.view · registar, pagar, anular e categorias: finance.expenses.manage. */
@ApiTags("Portal · Finanças · Despesas")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/finance/expenses")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class ExpensesController {
  constructor(
    private readonly expenses: Expenses,
    private readonly stores: HrFileStores,
  ) {}

  @Get()
  @RequirePermission("finance.expenses.view")
  @ApiOperation({ summary: "Despesas (filtros: estado ou OVERDUE, categoria, mês, pesquisa, página)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(query) q: { estado?: string; categoria?: string; mes?: string; q?: string; pagina?: number }) {
    return this.expenses.list(repo(t), await actorOf(t, u), { status: q.estado, categoryId: q.categoria, month: q.mes, q: q.q, page: q.pagina });
  }

  @Post()
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Registar uma despesa (por pagar)" })
  @ApiBody({ schema: openApi(expenseBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(expenseBody)) body: z.infer<typeof expenseBody>) {
    return unwrap(await this.expenses.create(repo(t), await actorOf(t, u), body, !!body.confirm), PAYMENTS_HTTP);
  }

  @Post("categories")
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Juntar categorias" })
  @ApiBody({ schema: openApi(categoriesBody) })
  async addCategories(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(categoriesBody)) body: { names: string[] }) {
    return unwrap(await this.expenses.addCategories(repo(t), await actorOf(t, u), body.names), PAYMENTS_HTTP);
  }

  @Patch("categories/:id")
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Mudar o nome de uma categoria" })
  @ApiBody({ schema: openApi(nameBody) })
  async renameCategory(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) categoryId: string, @Body(new ZodValidationPipe(nameBody)) body: { name: string }) {
    return unwrap(await this.expenses.renameCategory(repo(t), await actorOf(t, u), categoryId, body.name), PAYMENTS_HTTP);
  }

  @Delete("categories/:id")
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Apagar uma categoria (arquiva-se se já tem despesas)" })
  async removeCategory(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) categoryId: string) {
    return unwrap(await this.expenses.removeCategory(repo(t), await actorOf(t, u), categoryId), PAYMENTS_HTTP);
  }

  @Post("categories/:id/restore")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Voltar a usar uma categoria arquivada" })
  async restoreCategory(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) categoryId: string) {
    return unwrap(await this.expenses.restoreCategory(repo(t), await actorOf(t, u), categoryId), PAYMENTS_HTTP);
  }

  @Get(":id")
  @RequirePermission("finance.expenses.view")
  @ApiOperation({ summary: "Uma despesa, com o histórico" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) expenseId: string) {
    return unwrap(await this.expenses.detail(repo(t), await actorOf(t, u), expenseId), PAYMENTS_HTTP);
  }

  @Put(":id")
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Alterar uma despesa (paga: menos o valor e a data)" })
  @ApiBody({ schema: openApi(expenseBody) })
  async edit(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) expenseId: string, @Body(new ZodValidationPipe(expenseBody)) body: z.infer<typeof expenseBody>) {
    return unwrap(await this.expenses.edit(repo(t), await actorOf(t, u), expenseId, body, !!body.confirm), PAYMENTS_HTTP);
  }

  @Post(":id/pay")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Marcar como paga" })
  @ApiBody({ schema: openApi(payBody) })
  async pay(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) expenseId: string, @Body(new ZodValidationPipe(payBody)) body: z.infer<typeof payBody>) {
    return unwrap(await this.expenses.pay(repo(t), await actorOf(t, u), expenseId, body), PAYMENTS_HTTP);
  }

  @Post(":id/unpay")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Repor como por pagar, com motivo" })
  @ApiBody({ schema: openApi(reasonBody) })
  async unpay(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) expenseId: string, @Body(new ZodValidationPipe(reasonBody)) body: { reason: string }) {
    return unwrap(await this.expenses.unpay(repo(t), await actorOf(t, u), expenseId, body.reason), PAYMENTS_HTTP);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @ApiOperation({ summary: "Anular uma despesa por pagar, com motivo" })
  @ApiBody({ schema: openApi(reasonBody) })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) expenseId: string, @Body(new ZodValidationPipe(reasonBody)) body: { reason: string }) {
    return unwrap(await this.expenses.cancel(repo(t), await actorOf(t, u), expenseId, body.reason), PAYMENTS_HTTP);
  }

  @Post(":id/proof")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.expenses.view", "finance.expenses.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: (PROOF_MAX_MB + 1) * 1024 * 1024, files: 1, fields: 2 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Juntar (ou trocar) o comprovativo: PDF, JPG ou PNG, cifrado" })
  async attach(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) expenseId: string, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    return unwrap(await this.expenses.attach(repo(t), this.stores.for(t.entry), await actorOf(t, u), expenseId, file), PAYMENTS_HTTP);
  }

  @Get(":id/proof")
  @RequirePermission("finance.expenses.view")
  @ApiOperation({ summary: "O comprovativo (decifrado pela API)" })
  async proof(@CurrentTenant() t: TenantContext, @Param("id", id) expenseId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.expenses.proof(repo(t), this.stores.for(t.entry), expenseId), PAYMENTS_HTTP));
  }
}
