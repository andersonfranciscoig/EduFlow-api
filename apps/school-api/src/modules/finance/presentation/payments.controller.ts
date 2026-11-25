import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { z } from "zod";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { luandaToday } from "../../family/domain/family";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { HrFileStores } from "../../hr/infrastructure/hr-file-store";
import { sendFile } from "../../hr/presentation/employees.controller";
import type { SchoolAccess } from "../../identity/application/ports";
import { NoTeachersGuard, permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { type PaymentActor, type PaymentChannels, Payments } from "../application/Payments";
import { FUTURE_METHODS, type PaymentErrorCode, paymentError, PROOF_MAX_MB, REQUEST_LABELS } from "../domain/payments";
import { PaymentRequests } from "../infrastructure/payment-requests";
import { PrismaPaymentsRepository } from "../infrastructure/prisma-payments";

export const PAYMENTS_HTTP: Partial<Record<PaymentErrorCode, HttpStatus>> = {
  INVALID_INPUT: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_FILE: HttpStatus.UNPROCESSABLE_ENTITY,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  PAYMENTS_OFF: HttpStatus.CONFLICT,
  ACCOUNT_IN_USE: HttpStatus.CONFLICT,
  ACCOUNT_EXISTS: HttpStatus.CONFLICT,
  DUPLICATE_TRANSACTION: HttpStatus.CONFLICT,
  CHARGES_CHANGED: HttpStatus.CONFLICT,
  STORAGE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  PLATFORM_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

type Upload = { originalname: string; buffer: Buffer } | undefined;
const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const configBody = z
  .object({
    transferEnabled: z.boolean(),
    requireApplication: z.boolean(),
    requireEnrollment: z.boolean(),
    monthlyFrom: z.string().max(7).nullish(),
    validationHours: z.number().int(),
    instructions: z.string().max(600).nullish(),
  })
  .meta({ title: "PaymentSettings", description: "Transferência/depósito, o que se exige pago e a partir de que mês se cobram as propinas." });
const accountBody = z
  .object({ bankName: z.string().max(80), holder: z.string().max(160), accountNumber: z.string().max(40).nullish(), iban: z.string().max(60), notes: z.string().max(300).nullish(), active: z.boolean() })
  .meta({ title: "BankAccount", description: "Coordenadas bancárias do colégio (IBAN confirmado)." });
const requestBody = z.object({ method: z.enum(["REFERENCIA", "EXPRESS"], { error: "Escolha a forma de pagamento." }), note: z.string().max(500).nullish() }).meta({ title: "PaymentMethodRequest", description: "Pedir à EduFlow o pagamento por referência ou Express (lista de espera)." });
const reasonBody = z.object({ reason: z.string().max(400) }).meta({ title: "PaymentReason" });
const listQuery = new ZodValidationPipe(z.object({ estado: z.string().max(20).optional(), q: z.string().max(80).optional(), pagina: z.coerce.number().int().min(1).max(5000).optional() }));
const chargesQuery = new ZodValidationPipe(z.object({ estado: z.string().max(20).optional(), tipo: z.string().max(20).optional(), ano: z.uuid().optional(), q: z.string().max(80).optional(), pagina: z.coerce.number().int().min(1).max(5000).optional() }));
// multipart: tudo chega como texto
const submitBody = z
  .object({
    chargeIds: z.string().max(2000),
    bankAccountId: z.uuid({ error: "Escolha a conta bancária." }),
    method: z.string().max(20),
    transactionNumber: z.string().max(80),
    paidOn: day,
    note: z.string().max(400).optional(),
    total: z.coerce.number().int().optional(),
  })
  .meta({ title: "PaymentSubmit", description: "chargeIds: os ids separados por vírgulas · total: o valor que a pessoa viu · file: o comprovativo." });
const submitInput = (b: z.infer<typeof submitBody>) => ({ chargeIds: b.chargeIds.split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)), bankAccountId: b.bankAccountId, method: b.method, transactionNumber: b.transactionNumber, paidOn: b.paidOn, note: b.note });
const proofFile = FileInterceptor("file", { limits: { fileSize: (PROOF_MAX_MB + 1) * 1024 * 1024, files: 1, fields: 10 } });

const repo = (t: TenantContext) => new PrismaPaymentsRepository(t.db);
export function paymentChannels(notifier: Notifier, t: TenantContext): PaymentChannels {
  const tenant = { slug: t.entry.slug, name: t.entry.schoolName };
  return { staff: notifier.for(t.db, tenant), familyEmail: (m) => notifier.familyEmail(tenant, { ...m, kind: "PAYMENT" }) };
}
export async function paymentActor(t: TenantContext, u: SchoolAccess): Promise<PaymentActor> {
  const p = await permissionsOf(t.db, u);
  return { id: u.id, canValidate: p.includes("finance.payments.validate"), canCharge: p.includes("finance.charges.manage"), canConfigure: p.includes("finance.settings.manage") };
}

/**
 * Finanças · pagamentos. Configurar: finance.settings.manage · ver: finance.payments.view ·
 * validar/recusar: finance.payments.validate · isentar e registar: finance.charges.manage.
 */
@ApiTags("Portal · Finanças · Pagamentos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/finance/payments")
@UseGuards(TenantGuard, SchoolAuthGuard, NoTeachersGuard)
export class PaymentsController {
  constructor(
    private readonly payments: Payments,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
    private readonly requests: PaymentRequests,
  ) {}

  // ---------------------------------------------------------------- configuração

  @Get("settings")
  @RequirePermission("finance.access")
  @ApiOperation({ summary: "Formas de pagamento, coordenadas bancárias e pedidos à EduFlow (referência, Express)" })
  async settings(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess) {
    const [config, req] = await Promise.all([this.payments.config(repo(t), await paymentActor(t, u)), this.requests.list(t.entry.schoolId)]);
    return {
      ...config,
      /** null = a lista de espera não está disponível agora */
      future: Object.entries(FUTURE_METHODS).map(([method, m]) => {
        const r = req?.find((x) => x.method === method && x.status !== "CANCELLED");
        return { method, ...m, request: r ? { status: r.status, statusLabel: REQUEST_LABELS[r.status] ?? r.status, requestedAt: r.requestedAt.toISOString() } : null };
      }),
      requestsAvailable: req !== null,
    };
  }

  @Put("settings")
  @RequirePermission("finance.settings.manage")
  @ApiOperation({ summary: "Ligar/desligar a transferência e o depósito e as regras" })
  @ApiBody({ schema: openApi(configBody) })
  async saveSettings(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(configBody)) body: z.infer<typeof configBody>) {
    return unwrap(await this.payments.saveConfig(repo(t), await paymentActor(t, u), body), PAYMENTS_HTTP);
  }

  @Post("accounts")
  @RequirePermission("finance.settings.manage")
  @ApiOperation({ summary: "Juntar uma conta bancária" })
  @ApiBody({ schema: openApi(accountBody) })
  async addAccount(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(accountBody)) body: z.infer<typeof accountBody>) {
    return unwrap(await this.payments.saveAccount(repo(t), await paymentActor(t, u), null, body), PAYMENTS_HTTP);
  }

  @Put("accounts/:id")
  @RequirePermission("finance.settings.manage")
  @ApiOperation({ summary: "Alterar (ou desativar) uma conta bancária" })
  @ApiBody({ schema: openApi(accountBody) })
  async updateAccount(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) accountId: string, @Body(new ZodValidationPipe(accountBody)) body: z.infer<typeof accountBody>) {
    return unwrap(await this.payments.saveAccount(repo(t), await paymentActor(t, u), accountId, body), PAYMENTS_HTTP);
  }

  @Delete("accounts/:id")
  @RequirePermission("finance.settings.manage")
  @ApiOperation({ summary: "Apagar uma conta que nunca recebeu pagamentos" })
  async removeAccount(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) accountId: string) {
    return unwrap(await this.payments.removeAccount(repo(t), await paymentActor(t, u), accountId), PAYMENTS_HTTP);
  }

  @Post("requests")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.settings.manage")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: "Pedir à EduFlow o pagamento por referência ou Express (lista de espera)" })
  @ApiBody({ schema: openApi(requestBody) })
  async request(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(requestBody)) body: z.infer<typeof requestBody>) {
    const r = await this.requests.request(t.entry.schoolId, body.method, body.note?.trim() || null, u.fullName);
    if (!r) return unwrap(fail(paymentError("PLATFORM_UNAVAILABLE", "Não foi possível enviar o pedido à EduFlow agora. Tente mais tarde.")), PAYMENTS_HTTP);
    await repo(t).record("PAYMENT_METHOD_REQUESTED", "00000000-0000-0000-0000-00000000f1a1", u.id, { method: body.method }, new Date());
    return unwrap(ok({ status: r, statusLabel: REQUEST_LABELS[r] ?? r }), PAYMENTS_HTTP);
  }

  @Delete("requests/:method")
  @RequirePermission("finance.settings.manage")
  @ApiOperation({ summary: "Retirar o pedido (só enquanto está na lista de espera)" })
  async cancelRequest(@CurrentTenant() t: TenantContext, @Param("method", new ZodValidationPipe(z.enum(["REFERENCIA", "EXPRESS"]))) method: "REFERENCIA" | "EXPRESS") {
    const r = await this.requests.cancel(t.entry.schoolId, method);
    if (r === null) return unwrap(fail(paymentError("PLATFORM_UNAVAILABLE", "Não foi possível contactar a EduFlow agora. Tente mais tarde.")), PAYMENTS_HTTP);
    if (!r) return unwrap(fail(paymentError("INVALID_STATE", "Este pedido já está a ser tratado pela EduFlow.")), PAYMENTS_HTTP);
    return { cancelled: true };
  }

  // ---------------------------------------------------------------- cobranças

  @Get("charges")
  @RequirePermission("finance.payments.view")
  @ApiOperation({ summary: "Cobranças (filtros: estado, tipo, ano, aluno, página)" })
  async charges(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(chargesQuery) q: { estado?: string; tipo?: string; ano?: string; q?: string; pagina?: number }) {
    return this.payments.charges(repo(t), await paymentActor(t, u), { status: q.estado, kind: q.tipo, yearId: q.ano, q: q.q, page: q.pagina });
  }

  @Post("charges/:id/waive")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.payments.view", "finance.charges.manage")
  @ApiOperation({ summary: "Isentar uma cobrança, com motivo" })
  @ApiBody({ schema: openApi(reasonBody) })
  async waive(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) chargeId: string, @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    return unwrap(await this.payments.waive(repo(t), await paymentActor(t, u), chargeId, body.reason, t), PAYMENTS_HTTP);
  }

  @Post("charges/:id/reopen")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.payments.view", "finance.charges.manage")
  @ApiOperation({ summary: "Retirar a isenção" })
  async reopen(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) chargeId: string) {
    return unwrap(await this.payments.reopen(repo(t), await paymentActor(t, u), chargeId), PAYMENTS_HTTP);
  }

  // ---------------------------------------------------------------- pagamentos

  @Get()
  @RequirePermission("finance.payments.view")
  @ApiOperation({ summary: "Pagamentos (filtros: estado ou OVERDUE, pesquisa, página)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(listQuery) q: { estado?: string; q?: string; pagina?: number }) {
    return this.payments.list(repo(t), await paymentActor(t, u), { status: q.estado, q: q.q, page: q.pagina });
  }

  @Post()
  @RequirePermission("finance.payments.view", "finance.charges.manage")
  @UseInterceptors(proofFile)
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Registar um pagamento entregue em mão (fica em validação)" })
  async register(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Body(new ZodValidationPipe(submitBody)) body: z.infer<typeof submitBody>, @UploadedFile() file: Upload) {
    return unwrap(await this.payments.staffSubmit(repo(t), this.stores.for(t.entry), await paymentActor(t, u), submitInput(body), file, body.total ?? null, paymentChannels(this.notifier, t)), PAYMENTS_HTTP);
  }

  @Get("options")
  @RequirePermission("finance.payments.view")
  @ApiOperation({ summary: "As contas bancárias ativas, o dia e o prazo (para registar um pagamento)" })
  async options(@CurrentTenant() t: TenantContext) {
    return { today: luandaToday(new Date()), validationHours: (await repo(t).settings()).validationHours, accounts: (await repo(t).accounts(true)).map((a) => ({ id: a.id, bankName: a.bankName, holder: a.holder, iban: a.iban })) };
  }

  @Get(":id")
  @RequirePermission("finance.payments.view")
  @ApiOperation({ summary: "Um pagamento: o que paga, a transação, o histórico" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) paymentId: string) {
    return unwrap(await this.payments.detail(repo(t), await paymentActor(t, u), paymentId), PAYMENTS_HTTP);
  }

  @Get(":id/proof")
  @RequirePermission("finance.payments.view")
  @ApiOperation({ summary: "O comprovativo (decifrado pela API)" })
  async proof(@CurrentTenant() t: TenantContext, @Param("id", id) paymentId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.payments.proof(repo(t), this.stores.for(t.entry), paymentId), PAYMENTS_HTTP));
  }

  @Post(":id/validate")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.payments.view", "finance.payments.validate")
  @ApiOperation({ summary: "Validar: as cobranças ficam pagas; a família, a secretaria e as Finanças são avisadas" })
  async validate(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) paymentId: string) {
    return unwrap(await this.payments.validate(repo(t), await paymentActor(t, u), paymentId, paymentChannels(this.notifier, t), t), PAYMENTS_HTTP);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("finance.payments.view", "finance.payments.validate")
  @ApiOperation({ summary: "Recusar (ou anular uma validação), com motivo" })
  @ApiBody({ schema: openApi(reasonBody) })
  async reject(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) paymentId: string, @Body(new ZodValidationPipe(reasonBody)) body: z.infer<typeof reasonBody>) {
    return unwrap(await this.payments.reject(repo(t), await paymentActor(t, u), paymentId, body.reason, paymentChannels(this.notifier, t)), PAYMENTS_HTTP);
  }
}

/** Área da família · pagamentos (as inscrições da conta e os alunos a que tem acesso). */
@ApiTags("Área da família · Pagamentos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/family/payments")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyPaymentsController {
  constructor(
    private readonly payments: Payments,
    private readonly stores: HrFileStores,
    private readonly notifier: Notifier,
  ) {}

  @Get()
  @ApiOperation({ summary: "O que há a pagar, as contas do colégio e os pagamentos feitos" })
  home(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.payments.familyHome(repo(t), f.account.id);
  }

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(proofFile)
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Enviar um pagamento: conta, n.º da transação, data e comprovativo (PDF/JPG/PNG); fica em validação" })
  async submit(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(submitBody)) body: z.infer<typeof submitBody>, @UploadedFile() file: Upload) {
    return unwrap(await this.payments.familySubmit(repo(t), this.stores.for(t.entry), f.account, submitInput(body), file, body.total ?? null, paymentChannels(this.notifier, t)), PAYMENTS_HTTP);
  }

  @Get(":id")
  @ApiOperation({ summary: "Um pagamento da conta" })
  async one(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) paymentId: string) {
    return unwrap(await this.payments.familyPayment(repo(t), f.account.id, paymentId), PAYMENTS_HTTP);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Retirar um pagamento ainda em validação" })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) paymentId: string) {
    return unwrap(await this.payments.familyCancel(repo(t), f.account.id, paymentId, paymentChannels(this.notifier, t)), PAYMENTS_HTTP);
  }

  @Get(":id/proof")
  @ApiOperation({ summary: "O comprovativo enviado" })
  async proof(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) paymentId: string, @Res({ passthrough: true }) res: Response) {
    return sendFile(res, unwrap(await this.payments.proof(repo(t), this.stores.for(t.entry), paymentId, f.account.id), PAYMENTS_HTTP));
  }
}
