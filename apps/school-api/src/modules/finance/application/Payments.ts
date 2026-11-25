import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { sha256 } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { luandaToday } from "../../family/domain/family";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { FORMAT_MIME, MB, safeFileName, sniffFormat } from "../../hr/domain/employee";
import { KINDS } from "../../notifications/domain/catalog";
import type { EmailSection, StaffNotify } from "../../notifications/infrastructure/notifier";
import { gradeLabel } from "../../pedagogy/domain/academic";
import {
  type BankAccountInput,
  CHARGE_KINDS,
  CHARGE_LABELS,
  checkAccount,
  checkReason,
  checkSubmit,
  clean,
  kz,
  lateFee,
  MAX_ACCOUNTS,
  METHOD_LABELS,
  PAYMENT_LABELS,
  type PaymentError,
  paymentError,
  paymentNumber,
  type PaymentStatus,
  PROOF_FORMATS,
  PROOF_MAX_MB,
  type SubmitInput,
} from "../domain/payments";
import type { AccountRow, ChargeRow, PaymentRow, PrismaPaymentsRepository, SettingsRow } from "../infrastructure/prisma-payments";

type R<T> = Promise<Result<T, PaymentError>>;
type Upload = { originalname: string; buffer: Buffer } | undefined;
export interface PaymentActor {
  id: string;
  canValidate: boolean;
  canCharge: boolean;
  canConfigure: boolean;
}
/** Para avisar: a equipa e o email da família (já ligados ao colégio). */
export interface PaymentChannels {
  staff: StaffNotify;
  familyEmail: (m: { to: { email: string; name: string }; title: string; body: string; link: string; sections: EmailSection[] }) => Promise<void>;
}
const FINANCE = ["finance.payments.view", "finance.payments.validate"];
const OFFICE = ["admissions.applications.view", "admissions.enrollments.manage"];
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const classLabel = (c: Pick<ChargeRow, "grade" | "courseName">) => (c.grade === null ? null : `${gradeLabel(c.grade)}${c.courseName ? ` — ${c.courseName}` : ""}`);

export const accountDto = (a: AccountRow) => ({ id: a.id, bankName: a.bankName, holder: a.holder, accountNumber: a.accountNumber, iban: a.iban, notes: a.notes, active: a.active, used: a.used });
export function chargeDto(c: ChargeRow, today: string) {
  const overdue = c.status === "OPEN" && !!c.dueOn && c.dueOn < today;
  const fee = c.status === "OPEN" ? lateFee(c.amount, c.dueOn, today, c.planKind ? { kind: c.planKind, value: c.planValue ?? 0 } : null) : 0;
  return {
    id: c.id,
    kind: c.kind,
    kindLabel: CHARGE_KINDS[c.kind],
    label: c.label,
    amount: c.amount,
    /** multa, se se pagasse hoje */
    lateFee: fee,
    total: c.amount + fee,
    yearName: c.yearName,
    student: { id: c.studentId, name: c.studentName, number: c.studentNumber ? String(c.studentNumber).padStart(5, "0") : null },
    application: c.applicationId ? { id: c.applicationId, number: c.applicationNumber } : null,
    classLabel: classLabel(c),
    groupName: c.groupName,
    month: c.month,
    dueOn: c.dueOn,
    overdue,
    status: c.status,
    inValidation: !!c.pendingPaymentId,
    statusLabel: c.status === "OPEN" && c.pendingPaymentId ? "Em validação" : c.status === "OPEN" && overdue ? "Em atraso" : CHARGE_LABELS[c.status],
    pendingPaymentId: c.pendingPaymentId,
    paidAt: c.paidAt?.toISOString() ?? null,
    waiveReason: c.waiveReason,
  };
}
export function paymentDto(p: PaymentRow, now: Date) {
  return {
    id: p.id,
    number: paymentNumber(p.number),
    payerName: p.payerName,
    payerEmail: p.payerEmail,
    method: p.method,
    methodLabel: METHOD_LABELS[p.method],
    bank: { name: p.bankName, iban: p.bankIban },
    transactionNumber: p.transactionNumber,
    paidOn: p.paidOn,
    total: p.total,
    note: p.note,
    proof: { name: p.proofName, mimeType: p.proofMimeType, size: p.proofSize },
    status: p.status,
    statusLabel: PAYMENT_LABELS[p.status],
    byStaff: p.createdByKind === "STAFF",
    submittedAt: p.submittedAt.toISOString(),
    dueAt: p.dueAt.toISOString(),
    overdue: p.status === "SUBMITTED" && p.dueAt < now,
    decidedBy: p.decidedByName,
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    items: p.items.map((i) => ({ chargeId: i.chargeId, label: i.label, kind: i.kind, kindLabel: CHARGE_KINDS[i.kind], amount: i.amount, lateFee: i.lateFee, studentName: i.studentName })),
    students: [...new Set(p.items.map((i) => i.studentName))],
  };
}

/**
 * Pagamentos por transferência/depósito. Família: vê o que tem a pagar, paga numa das contas do colégio e
 * envia o n.º da transação e o comprovativo; fica em validação (até 48 h). Finanças: valida ou recusa, isenta
 * cobranças, regista pagamentos entregues em mão. Nada conta como pago antes de ser validado.
 */
export class Payments {
  /** Chamado quando uma inscrição/matrícula fica com tudo pago (ex.: matrícula automática). */
  private readonly settled: ((ctx: unknown, applicationIds: string[]) => Promise<void>)[] = [];

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  onSettled(fn: (ctx: unknown, applicationIds: string[]) => Promise<void>) {
    this.settled.push(fn);
  }

  private today() {
    return luandaToday(this.clock.now());
  }
  /** O colégio recebe pagamentos (ligados e com pelo menos uma conta ativa)? */
  private async online(repo: PrismaPaymentsRepository, s: SettingsRow) {
    return s.transferEnabled && (await repo.accounts(true)).length > 0;
  }

  // ============================================================ configuração

  async config(repo: PrismaPaymentsRepository, actor: PaymentActor) {
    const [s, accounts] = await Promise.all([repo.settings(), repo.accounts()]);
    return {
      canManage: actor.canConfigure,
      transferEnabled: s.transferEnabled,
      activeSince: s.activeSince?.toISOString() ?? null,
      requireApplication: s.requireApplication,
      requireEnrollment: s.requireEnrollment,
      monthlyFrom: s.monthlyFrom,
      validationHours: s.validationHours,
      instructions: s.instructions,
      thisMonth: this.today().slice(0, 7),
      accounts: accounts.map(accountDto),
      maxAccounts: MAX_ACCOUNTS,
    };
  }

  async saveConfig(repo: PrismaPaymentsRepository, actor: PaymentActor, input: { transferEnabled: boolean; requireApplication: boolean; requireEnrollment: boolean; monthlyFrom?: string | null; validationHours: number; instructions?: string | null }): R<{ saved: true }> {
    if (!actor.canConfigure) return fail(paymentError("FORBIDDEN", "Não tem permissão para configurar os pagamentos."));
    const s = await repo.settings();
    const instructions = clean(input.instructions) || null;
    if (instructions && instructions.length > 500) return fail(paymentError("INVALID_INPUT", "As instruções têm no máximo 500 caracteres."));
    if (!Number.isInteger(input.validationHours) || input.validationHours < 1 || input.validationHours > 48) return fail(paymentError("INVALID_INPUT", "O prazo da validação vai de 1 a 48 horas."));
    if (input.transferEnabled && !(await repo.accounts(true)).length) return fail(paymentError("INVALID_STATE", "Para receber por transferência ou depósito, indique primeiro uma conta bancária ativa."));
    const now = this.clock.now();
    // ao ligar pela primeira vez, as propinas começam no mês seguinte (o mês em curso pode já ter sido pago na
    // secretaria e estar fora do prazo); o colégio pode escolher outro mês nas regras
    const [y, m] = this.today().split("-").map(Number);
    const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    const monthlyFrom = input.monthlyFrom ?? s.monthlyFrom ?? (input.transferEnabled ? nextMonth : null);
    if (monthlyFrom && !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthlyFrom)) return fail(paymentError("INVALID_INPUT", "Escolha o mês a partir do qual se cobram as propinas."));
    const next: SettingsRow = { transferEnabled: input.transferEnabled, activeSince: s.activeSince ?? (input.transferEnabled ? now : null), requireApplication: input.requireApplication, requireEnrollment: input.requireEnrollment, monthlyFrom, validationHours: input.validationHours, instructions };
    await repo.saveSettings(next, actor.id, now);
    await repo.record("PAYMENT_SETTINGS_SAVED", "00000000-0000-0000-0000-00000000f1a1", actor.id, { before: { ...s, activeSince: s.activeSince?.toISOString() ?? null }, after: { ...next, activeSince: next.activeSince?.toISOString() ?? null } }, now);
    await repo.sync(next, now);
    return ok({ saved: true as const });
  }

  async saveAccount(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string | null, input: BankAccountInput): R<{ id: string }> {
    if (!actor.canConfigure) return fail(paymentError("FORBIDDEN", "Não tem permissão para configurar os pagamentos."));
    const a = checkAccount(input);
    if (!a.ok) return a;
    const all = await repo.accounts();
    const before = id ? all.find((x) => x.id === id) : null;
    if (id && !before) return fail(paymentError("NOT_FOUND", "Conta não encontrada."));
    if (!id && all.length >= MAX_ACCOUNTS) return fail(paymentError("INVALID_INPUT", `No máximo ${MAX_ACCOUNTS} contas.`));
    const s = await repo.settings();
    if (s.transferEnabled && before?.active && !a.value.active && all.filter((x) => x.active).length === 1) return fail(paymentError("INVALID_STATE", "É a única conta ativa: desative antes a transferência/depósito ou ative outra conta."));
    const now = this.clock.now();
    const accountId = id ?? this.ids.next();
    if (!(await repo.saveAccount({ id: accountId, ...a.value }, now))) return fail(paymentError("ACCOUNT_EXISTS", "Já existe uma conta com este IBAN."));
    await repo.record(before ? "BANK_ACCOUNT_CHANGED" : "BANK_ACCOUNT_ADDED", accountId, actor.id, { before: before ? accountDto(before) : null, after: a.value }, now);
    return ok({ id: accountId });
  }

  async removeAccount(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string): R<{ removed: true }> {
    if (!actor.canConfigure) return fail(paymentError("FORBIDDEN", "Não tem permissão para configurar os pagamentos."));
    const all = await repo.accounts();
    const a = all.find((x) => x.id === id);
    if (!a) return fail(paymentError("NOT_FOUND", "Conta não encontrada."));
    if (a.active && all.filter((x) => x.active).length === 1 && (await repo.settings()).transferEnabled) return fail(paymentError("INVALID_STATE", "É a única conta ativa: desative antes a transferência/depósito ou ative outra conta."));
    if (!(await repo.removeAccount(id))) return fail(paymentError("ACCOUNT_IN_USE", "Esta conta já recebeu pagamentos: desative-a em vez de a apagar."));
    await repo.record("BANK_ACCOUNT_REMOVED", id, actor.id, { before: accountDto(a) }, this.clock.now());
    return ok({ removed: true as const });
  }

  // ============================================================ família

  async familyHome(repo: PrismaPaymentsRepository, accountId: string) {
    const s = await repo.settings();
    const now = this.clock.now();
    const today = this.today();
    await repo.sync(s, now, { accountId });
    const [charges, payments, accounts] = await Promise.all([repo.familyCharges(accountId, today), repo.familyPayments(accountId), repo.accounts(true)]);
    const list = charges.map((c) => chargeDto(c, today));
    const open = list.filter((c) => c.status === "OPEN" && !c.inValidation);
    return {
      today,
      online: s.transferEnabled && accounts.length > 0,
      validationHours: s.validationHours,
      instructions: s.instructions,
      accounts: accounts.map((a) => ({ id: a.id, bankName: a.bankName, holder: a.holder, accountNumber: a.accountNumber, iban: a.iban, notes: a.notes })),
      totals: { open: open.reduce((n, c) => n + c.total, 0), overdue: open.filter((c) => c.overdue).reduce((n, c) => n + c.total, 0), inValidation: payments.filter((p) => p.status === "SUBMITTED").reduce((n, p) => n + p.total, 0) },
      charges: list,
      payments: payments.map((p) => paymentDto(p, now)),
    };
  }

  /** A multa na data em que se pagou (para quem preenche ver o total certo). */
  private items(charges: ChargeRow[], paidOn: string) {
    return charges.map((c) => ({ chargeId: c.id, label: `${c.label}${c.studentName ? ` · ${c.studentName}` : ""}`.slice(0, 200), amount: c.amount, lateFee: lateFee(c.amount, c.dueOn, paidOn, c.planKind ? { kind: c.planKind, value: c.planValue ?? 0 } : null) }));
  }

  private async submit(
    repo: PrismaPaymentsRepository,
    files: HrFileStore,
    by: { kind: "FAMILY"; accountId: string; name: string } | { kind: "STAFF"; userId: string; accountId: string | null; name: string },
    input: SubmitInput,
    file: Upload,
    /** o total que a pessoa viu (se entretanto mudou, não grava) */
    expectedTotal: number | null,
  ): R<PaymentRow> {
    const today = this.today();
    const now = this.clock.now();
    const data = checkSubmit(input, today);
    if (!data.ok) return data;
    const s = await repo.settings();
    if (!s.transferEnabled) return fail(paymentError("PAYMENTS_OFF", "Este colégio ainda não recebe pagamentos por aqui."));
    const bank = (await repo.accounts(true)).find((a) => a.id === input.bankAccountId);
    if (!bank) return fail(paymentError("INVALID_INPUT", "Escolha uma das contas bancárias do colégio."));
    const charges = await repo.chargesByIds(data.value.chargeIds, by.kind === "FAMILY" ? { accountId: by.accountId, today } : undefined);
    if (charges.length !== data.value.chargeIds.length) return fail(paymentError("NOT_FOUND", "Uma das cobranças não foi encontrada."));
    if (charges.some((c) => c.status !== "OPEN" || c.pendingPaymentId)) return fail(paymentError("CHARGES_CHANGED", "Uma das cobranças já foi paga ou está em validação. Atualize a página."));
    const items = this.items(charges, data.value.paidOn);
    const total = items.reduce((n, i) => n + i.amount + i.lateFee, 0);
    if (expectedTotal !== null && expectedTotal !== total) return fail(paymentError("CHARGES_CHANGED", `O total para ${dmy(data.value.paidOn)} é ${kz(total)}. Confirme o valor antes de enviar.`, { total }));
    if (!file?.buffer?.length) return fail(paymentError("INVALID_FILE", "Junte o comprovativo (PDF, JPG ou PNG)."));
    if (file.buffer.length > PROOF_MAX_MB * MB) return fail(paymentError("INVALID_FILE", `O comprovativo tem mais de ${PROOF_MAX_MB} MB.`));
    const format = sniffFormat(file.buffer, file.originalname);
    if (!format || !PROOF_FORMATS.includes(format)) return fail(paymentError("INVALID_FILE", "Formato não aceite. Envie o comprovativo em PDF, JPG ou PNG."));
    if (!files.ready) return fail(paymentError("STORAGE_UNAVAILABLE", "O envio de ficheiros ainda não está disponível neste colégio. Fale com a secretaria."));
    const id = this.ids.next();
    const name = safeFileName(file.originalname, format);
    let key: string;
    try {
      key = (await files.save("pagamentos", { fileName: name, mimeType: FORMAT_MIME[format], content: file.buffer })).key;
    } catch {
      return fail(paymentError("STORAGE_UNAVAILABLE", "Não foi possível guardar o comprovativo agora. Tente de novo dentro de instantes."));
    }
    const r = await repo.submit(
      {
        id,
        accountId: by.accountId,
        payerName: by.name,
        method: data.value.method,
        bank: { id: bank.id, name: bank.bankName, iban: bank.iban },
        transactionNumber: data.value.transactionNumber,
        paidOn: data.value.paidOn,
        note: data.value.note,
        proof: { name, mimeType: FORMAT_MIME[format], size: file.buffer.length, sha256: sha256(file.buffer), storageKey: key },
        createdByKind: by.kind,
        createdById: by.kind === "FAMILY" ? by.accountId : by.userId,
        dueAt: new Date(now.getTime() + s.validationHours * 3_600_000),
        now,
      },
      items,
    );
    if (!r.ok) {
      await files.remove(key).catch(() => undefined);
      return r.reason === "duplicate" ? fail(paymentError("DUPLICATE_TRANSACTION", "Este n.º de transação já foi usado noutro pagamento para esta conta. Confirme o número no comprovativo.")) : fail(paymentError("CHARGES_CHANGED", "Uma das cobranças mudou entretanto. Atualize a página."));
    }
    return ok((await repo.payment(id))!);
  }

  async familySubmit(repo: PrismaPaymentsRepository, files: HrFileStore, account: { id: string; fullName: string; email: string }, input: SubmitInput, file: Upload, expectedTotal: number | null, ch: PaymentChannels): R<ReturnType<typeof paymentDto> & { message: string }> {
    const r = await this.submit(repo, files, { kind: "FAMILY", accountId: account.id, name: account.fullName }, input, file, expectedTotal);
    if (!r.ok) return r;
    const s = await repo.settings();
    this.later(() => this.announce(repo, r.value, ch, "SUBMITTED", s.validationHours));
    return ok({ ...paymentDto(r.value, this.clock.now()), message: `Pagamento recebido. Será validado pelas Finanças do colégio em ${s.validationHours} horas ou menos.` });
  }

  async familyCancel(repo: PrismaPaymentsRepository, accountId: string, id: string, ch: PaymentChannels): R<{ cancelled: true }> {
    const p = await repo.payment(id, accountId);
    if (!p) return fail(paymentError("NOT_FOUND", "Pagamento não encontrado."));
    if (p.createdByKind !== "FAMILY") return fail(paymentError("FORBIDDEN", "Este pagamento foi registado pelo colégio."));
    if (!(await repo.decide(id, ["SUBMITTED"], "CANCELLED", { actorId: null, note: null, now: this.clock.now(), record: "PAYMENT_CANCELLED", family: null }))) return fail(paymentError("INVALID_STATE", "Este pagamento já foi decidido: já não se pode retirar."));
    this.later(async () => this.announce(repo, (await repo.payment(id))!, ch, "CANCELLED", 0));
    return ok({ cancelled: true as const });
  }

  async proof(repo: PrismaPaymentsRepository, files: HrFileStore, id: string, accountId?: string) {
    const p = await repo.payment(id, accountId);
    if (!p) return fail(paymentError("NOT_FOUND", "Pagamento não encontrado."));
    return ok({ content: await files.read(p.proofStorageKey), mimeType: p.proofMimeType, fileName: p.proofName });
  }

  async familyPayment(repo: PrismaPaymentsRepository, accountId: string, id: string) {
    const p = await repo.payment(id, accountId);
    return p ? ok(paymentDto(p, this.clock.now())) : fail(paymentError("NOT_FOUND", "Pagamento não encontrado."));
  }

  // ============================================================ finanças

  async list(repo: PrismaPaymentsRepository, actor: PaymentActor, input: { status?: string; q?: string; page?: number }) {
    const now = this.clock.now();
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = 20;
    const status = input.status && input.status in PAYMENT_LABELS ? (input.status as PaymentStatus) : undefined;
    const [r, counts, s] = await Promise.all([repo.listPayments({ status, overdue: input.status === "OVERDUE" ? now : undefined, q: clean(input.q).slice(0, 80) || undefined, page, pageSize }), repo.paymentCounts(now), repo.settings()]);
    const by = (k: PaymentStatus) => counts.find((c) => c.status === k);
    return {
      can: { validate: actor.canValidate, charge: actor.canCharge },
      online: s.transferEnabled,
      validationHours: s.validationHours,
      page,
      pageSize,
      total: r.total,
      statuses: (Object.keys(PAYMENT_LABELS) as PaymentStatus[]).map((k) => ({ value: k, label: PAYMENT_LABELS[k], count: by(k)?.n ?? 0, amount: by(k)?.total ?? 0 })),
      overdue: by("SUBMITTED")?.overdue ?? 0,
      items: r.items.map((p) => paymentDto(p, now)),
    };
  }

  async detail(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string) {
    const p = await repo.payment(id);
    if (!p) return fail(paymentError("NOT_FOUND", "Pagamento não encontrado."));
    const history = await repo.history(id);
    const LABEL: Record<string, string> = { PAYMENT_SUBMITTED: "Submetido", PAYMENT_VALIDATED: "Validado", PAYMENT_REJECTED: "Recusado", PAYMENT_REVERSED: "Validação anulada", PAYMENT_CANCELLED: "Retirado pela família" };
    return ok({
      ...paymentDto(p, this.clock.now()),
      sameProof: p.sameProof,
      applications: [...new Set(p.items.map((i) => i.applicationId).filter((x): x is string => !!x))],
      can: { validate: actor.canValidate && p.status === "SUBMITTED", reject: actor.canValidate && p.status === "SUBMITTED", reverse: actor.canValidate && p.status === "VALIDATED" },
      history: history.map((h) => ({ at: h.at.toISOString(), label: LABEL[h.type] ?? h.type, by: h.by, reason: typeof h.details?.reason === "string" ? h.details.reason : null })),
    });
  }

  /** Validar: as cobranças ficam pagas e a família, a secretaria e as Finanças são avisadas. */
  async validate(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string, ch: PaymentChannels, ctx: unknown): R<{ status: PaymentStatus }> {
    if (!actor.canValidate) return fail(paymentError("FORBIDDEN", "Não tem permissão para validar pagamentos."));
    const p = await repo.payment(id);
    if (!p) return fail(paymentError("NOT_FOUND", "Pagamento não encontrado."));
    const done = await repo.decide(id, ["SUBMITTED"], "VALIDATED", { actorId: actor.id, note: null, now: this.clock.now(), record: "PAYMENT_VALIDATED", family: { title: `Pagamento validado · ${kz(p.total)}`, body: `${paymentNumber(p.number)}: ${p.items.map((i) => i.label).join(", ")}.` } });
    if (!done) return fail(paymentError("INVALID_STATE", "Este pagamento já foi decidido, ou uma das cobranças mudou. Atualize a página."));
    const apps = [...new Set(p.items.map((i) => i.applicationId).filter((x): x is string => !!x))];
    this.later(async () => {
      await this.announce(repo, (await repo.payment(id))!, ch, "VALIDATED", 0);
      if (apps.length) for (const fn of this.settled) await fn(ctx, apps);
    });
    return ok({ status: "VALIDATED" as const });
  }

  /** Recusar (ou anular uma validação feita por engano), sempre com motivo. */
  async reject(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string, rawReason: string, ch: PaymentChannels): R<{ status: PaymentStatus }> {
    if (!actor.canValidate) return fail(paymentError("FORBIDDEN", "Não tem permissão para validar pagamentos."));
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    const p = await repo.payment(id);
    if (!p) return fail(paymentError("NOT_FOUND", "Pagamento não encontrado."));
    const reversed = p.status === "VALIDATED";
    const done = await repo.decide(id, [p.status === "VALIDATED" ? "VALIDATED" : "SUBMITTED"], "REJECTED", {
      actorId: actor.id,
      note: reason.value,
      now: this.clock.now(),
      record: reversed ? "PAYMENT_REVERSED" : "PAYMENT_REJECTED",
      family: { title: `${reversed ? "Validação anulada" : "Pagamento não aceite"} · ${kz(p.total)}`, body: `${paymentNumber(p.number)}. Motivo: ${reason.value} As cobranças voltaram a ficar por pagar.` },
    });
    if (!done) return fail(paymentError("INVALID_STATE", "Este pagamento já foi decidido. Atualize a página."));
    this.later(async () => this.announce(repo, (await repo.payment(id))!, ch, "REJECTED", 0));
    return ok({ status: "REJECTED" as const });
  }

  /** As Finanças registam um pagamento entregue em mão (fica em validação como os outros). */
  async staffSubmit(repo: PrismaPaymentsRepository, files: HrFileStore, actor: PaymentActor, input: SubmitInput, file: Upload, expectedTotal: number | null, ch: PaymentChannels): R<ReturnType<typeof paymentDto>> {
    if (!actor.canCharge) return fail(paymentError("FORBIDDEN", "Não tem permissão para registar pagamentos."));
    const charges = await repo.chargesByIds([...new Set(input.chargeIds)].slice(0, 30));
    if (new Set(charges.map((c) => c.studentId ?? c.applicationId)).size > 1) return fail(paymentError("INVALID_INPUT", "Registe um pagamento por aluno."));
    const app = charges.find((c) => c.applicationId)?.applicationId;
    const owner = app ? await repo.application(app) : null;
    const r = await this.submit(repo, files, { kind: "STAFF", userId: actor.id, accountId: owner?.account_id ?? null, name: charges[0]?.studentName ?? "Aluno" }, input, file, expectedTotal);
    if (!r.ok) return r;
    this.later(() => this.announce(repo, r.value, ch, "SUBMITTED", 0));
    return ok(paymentDto(r.value, this.clock.now()));
  }

  async charges(repo: PrismaPaymentsRepository, actor: PaymentActor, input: { status?: string; kind?: string; q?: string; yearId?: string; page?: number }) {
    const s = await repo.settings();
    const today = this.today();
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = 30;
    const status = input.status && (["VALIDATION", "OVERDUE"].includes(input.status) || input.status in CHARGE_LABELS) ? input.status : undefined;
    const r = await repo.listCharges({ status, kind: input.kind && input.kind in CHARGE_KINDS ? input.kind : undefined, q: clean(input.q).slice(0, 80) || undefined, yearId: input.yearId, page, pageSize, today });
    return {
      can: { charge: actor.canCharge },
      online: s.transferEnabled,
      page,
      pageSize,
      total: r.total,
      amount: r.amount,
      kinds: Object.entries(CHARGE_KINDS).map(([value, label]) => ({ value, label })),
      statuses: [
        { value: "OPEN", label: "Por pagar" },
        { value: "OVERDUE", label: "Em atraso" },
        { value: "VALIDATION", label: "Em validação" },
        { value: "PAID", label: "Pagas" },
        { value: "WAIVED", label: "Isentas" },
      ],
      items: r.items.map((c) => chargeDto(c, today)),
    };
  }

  async waive(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string, rawReason: string, ctx: unknown): R<{ waived: true }> {
    if (!actor.canCharge) return fail(paymentError("FORBIDDEN", "Não tem permissão para isentar cobranças."));
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    const [c] = await repo.chargesByIds([id]);
    if (!c) return fail(paymentError("NOT_FOUND", "Cobrança não encontrada."));
    const now = this.clock.now();
    if (!(await repo.waive(id, reason.value, actor.id, now))) return fail(paymentError("INVALID_STATE", "Só se isenta uma cobrança por pagar e fora de validação."));
    await repo.record("CHARGE_WAIVED", id, actor.id, { label: c.label, amount: c.amount, student: c.studentName, reason: reason.value }, now);
    if (c.applicationId) {
      const apps = [c.applicationId];
      this.later(async () => {
        for (const fn of this.settled) await fn(ctx, apps);
      });
    }
    return ok({ waived: true as const });
  }

  async reopen(repo: PrismaPaymentsRepository, actor: PaymentActor, id: string): R<{ reopened: true }> {
    if (!actor.canCharge) return fail(paymentError("FORBIDDEN", "Não tem permissão para alterar cobranças."));
    const now = this.clock.now();
    if (!(await repo.reopen(id, actor.id, now))) return fail(paymentError("INVALID_STATE", "Só se repõe uma cobrança isenta."));
    await repo.record("CHARGE_REOPENED", id, actor.id, {}, now);
    return ok({ reopened: true as const });
  }

  // ============================================================ inscrições e matrículas

  /**
   * O que falta pagar para avançar (aprovar a inscrição / matricular). `null` = não impede: o colégio não
   * recebe por aqui, não o exige, ou está tudo pago/isento. Só o que as Finanças validaram conta.
   */
  async pending(repo: PrismaPaymentsRepository, applicationId: string, moment: "INSCRICAO" | "MATRICULA", /** as cobranças já foram postas em dia neste pedido */ synced = false): Promise<{ total: number; inValidation: boolean; message: string } | null> {
    const s = await repo.settings();
    if (!(moment === "INSCRICAO" ? s.requireApplication : s.requireEnrollment) || !(await this.online(repo, s))) return null;
    if (!synced) await repo.sync(s, this.clock.now(), { applicationId });
    const open = (await repo.applicationCharges(applicationId)).filter((c) => c.kind === moment && c.status === "OPEN");
    if (!open.length) return null;
    const inValidation = open.every((c) => c.pendingPaymentId);
    const total = open.reduce((n, c) => n + c.amount, 0);
    const what = moment === "INSCRICAO" ? "a inscrição" : "a matrícula";
    return { total, inValidation, message: inValidation ? `O pagamento d${what} está em validação nas Finanças.` : `Falta o pagamento d${what} (${kz(total)}), validado pelas Finanças.` };
  }

  /** O estado dos pagamentos de uma inscrição (para a secretaria e a família verem). */
  async forApplication(repo: PrismaPaymentsRepository, applicationId: string) {
    const s = await repo.settings();
    const online = await this.online(repo, s);
    if (!online) return { online: false, requireApplication: false, requireEnrollment: false, charges: [] as ReturnType<typeof chargeDto>[] };
    await repo.sync(s, this.clock.now(), { applicationId });
    const today = this.today();
    return { online: true, requireApplication: s.requireApplication, requireEnrollment: s.requireEnrollment, charges: (await repo.applicationCharges(applicationId)).map((c) => chargeDto(c, today)) };
  }

  /** Depois de aprovar ou submeter: avisa a família do que tem a pagar. */
  async tellDue(repo: PrismaPaymentsRepository, applicationId: string, moment: "INSCRICAO" | "MATRICULA") {
    const s = await repo.settings();
    if (!(await this.online(repo, s))) return;
    const now = this.clock.now();
    await repo.sync(s, now, { applicationId });
    const open = (await repo.applicationCharges(applicationId)).filter((c) => c.kind === moment && c.status === "OPEN" && !c.pendingPaymentId);
    const app = await repo.application(applicationId);
    if (!open.length || !app) return;
    const total = open.reduce((n, c) => n + c.amount, 0);
    await repo.tellFamily(app.account_id, `${moment === "INSCRICAO" ? "Pagamento da inscrição" : "Pagamento da matrícula"}: ${kz(total)}`, `${app.student}: ${open.map((c) => c.label).join(", ")}. Pague por transferência ou depósito e envie o comprovativo.`, app.student_id, now);
  }

  // ============================================================ ciclo automático

  /** As cobranças do dia e os pagamentos fora do prazo de validação. */
  async dailySync(repo: PrismaPaymentsRepository) {
    const s = await repo.settings();
    await repo.sync(s, this.clock.now());
    return { active: s.transferEnabled };
  }

  async overdue(repo: PrismaPaymentsRepository, staff: StaffNotify) {
    const list = await repo.claimOverdue(this.clock.now());
    if (!list.length) return 0;
    const s = await repo.settings();
    await staff.notify({
      kind: "PAYMENTS",
      userIds: await repo.staffWith(["finance.payments.validate"]),
      title: list.length === 1 ? "1 pagamento por validar fora do prazo" : `${list.length} pagamentos por validar fora do prazo`,
      body: `Passaram as ${s.validationHours} horas: ${list
        .slice(0, 5)
        .map((p) => `${paymentNumber(p.number)} de ${p.payer_name} (${kz(p.total)})`)
        .join("; ")}${list.length > 5 ? `; e mais ${list.length - 5}` : ""}.`,
      link: "/financas/pagamentos?estado=OVERDUE",
      dedupeKey: `payments-overdue:${list[0].id}`,
    });
    return list.length;
  }

  // ============================================================ avisos

  /** Depois da resposta: uma falha aqui fica no registo e não desfaz o pagamento. */
  private later(work: () => Promise<unknown>) {
    void work().catch((e: unknown) => console.error(`[pagamentos] aviso falhou: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Avisa as Finanças e a secretaria (na plataforma e por email) e a família por email. */
  private async announce(repo: PrismaPaymentsRepository, p: PaymentRow, ch: PaymentChannels, to: PaymentStatus, hours: number) {
    const number = paymentNumber(p.number);
    const what = `${kz(p.total)} · ${[...new Set(p.items.map((i) => i.studentName))].join(", ")}`;
    const title = { SUBMITTED: "Pagamento por validar", VALIDATED: "Pagamento validado", REJECTED: "Pagamento recusado", CANCELLED: "Pagamento retirado pela família" }[to];
    const lines = p.items.map((i) => `${i.label}: ${kz(i.amount)}${i.lateFee ? ` + multa ${kz(i.lateFee)}` : ""}`);
    const body = `${number} de ${p.payerName}: ${METHOD_LABELS[p.method].toLowerCase()} para ${p.bankName}, transação ${p.transactionNumber}, a ${dmy(p.paidOn)}.${p.decisionNote ? ` Motivo: ${p.decisionNote}` : ""}`;
    const key = `payment:${p.id}:${to}:${p.decidedAt?.getTime() ?? 0}`;
    const finance = await repo.staffWith(FINANCE);
    await ch.staff.notify({ kind: "PAYMENTS", userIds: finance, title: `${title} · ${what}`, body, link: `/financas/pagamentos/${p.id}`, dedupeKey: key, sections: [{ title: "O que paga", lines }] });
    // a secretaria (quem não é das Finanças): a ligação é a inscrição, se houver
    const office = (await repo.staffWith(OFFICE)).filter((id) => !finance.includes(id));
    const app = p.items.find((i) => i.applicationId)?.applicationId;
    if (office.length) await ch.staff.notify({ kind: "PAYMENTS", userIds: office, title: `${title} · ${what}`, body, link: app ? `/secretaria/inscricoes/${app}` : null, dedupeKey: key, sections: [{ title: "O que paga", lines }] });

    // a família: na plataforma já ficou (as decisões, na mesma transação); ao submeter, fica aqui
    if (!p.accountId) return;
    const now = this.clock.now();
    const family = {
      SUBMITTED: { title: `Pagamento em validação · ${kz(p.total)}`, body: `Recebemos o ${number}. Será validado pelas Finanças do colégio em ${hours || 48} horas ou menos.` },
      VALIDATED: { title: `Pagamento validado · ${kz(p.total)}`, body: `O ${number} foi validado pelas Finanças do colégio.` },
      REJECTED: { title: `Pagamento não aceite · ${kz(p.total)}`, body: `O ${number} não foi aceite. Motivo: ${p.decisionNote ?? ""} As cobranças voltaram a ficar por pagar.` },
      CANCELLED: null,
    }[to];
    if (!family) return;
    if (to === "SUBMITTED") await repo.tellFamily(p.accountId, family.title, family.body, null, now);
    const type = await repo.familyType();
    if (!(type?.enabled ?? KINDS.PAYMENT.defaultEnabled) || !(type?.email ?? KINDS.PAYMENT.defaultEmail) || !p.payerEmail) return;
    const log = (status: "SENT" | "FAILED" | "SKIPPED", error: string | null) => repo.logFamilyEmail({ accountId: p.accountId!, fullName: p.payerName, title: family.title, destination: p.payerEmail, status, error, now });
    if (!(await repo.familyWantsEmail(p.accountId))) return log("SKIPPED", "Recusado nas preferências");
    try {
      await ch.familyEmail({ to: { email: p.payerEmail, name: p.payerName }, title: family.title, body: family.body, link: `/familia/pagamentos?pagamento=${p.id}`, sections: [{ title: "Detalhe", lines }] });
    } catch (e) {
      return log("FAILED", String((e as Error).message).slice(0, 300));
    }
    await log("SENT", null);
  }
}
