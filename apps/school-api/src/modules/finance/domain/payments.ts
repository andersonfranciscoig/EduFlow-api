import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import type { LateFeeKind } from "./pricing";

/**
 * PAGAMENTOS por transferência ou depósito, validados à mão pelas Finanças.
 *
 *   cobrança   OPEN ──(num pagamento submetido: "em validação")──▶ PAID
 *                └─ isentar ─▶ WAIVED          deixou de se aplicar ─▶ VOID
 *   pagamento  SUBMITTED ──validar──▶ VALIDATED
 *                  ├─ recusar (motivo) ─▶ REJECTED      (as cobranças voltam a "por pagar")
 *                  └─ a família retira ─▶ CANCELLED
 *   Um pagamento validado por engano também se recusa (com motivo): as cobranças voltam a "por pagar".
 *
 * Nada conta como pago antes de as Finanças validarem. Referência e Multicaixa Express chegam em breve.
 */
export type ChargeKind = "INSCRICAO" | "MATRICULA" | "PROPINA" | "DOCUMENTO" | "OUTRA";
export type ChargeStatus = "OPEN" | "PAID" | "WAIVED" | "VOID";
export type PaymentStatus = "SUBMITTED" | "VALIDATED" | "REJECTED" | "CANCELLED";
export type PaymentMethod = "TRANSFERENCIA" | "DEPOSITO";
/** Formas de pagamento que hão de existir (pedem-se à EduFlow: lista de espera). */
export type FutureMethod = "REFERENCIA" | "EXPRESS";

export const CHARGE_KINDS: Record<ChargeKind, string> = { INSCRICAO: "Inscrição", MATRICULA: "Matrícula", PROPINA: "Propina", DOCUMENTO: "Documento", OUTRA: "Outra" };
export const CHARGE_LABELS: Record<ChargeStatus, string> = { OPEN: "Por pagar", PAID: "Paga", WAIVED: "Isenta", VOID: "Sem efeito" };
export const PAYMENT_LABELS: Record<PaymentStatus, string> = { SUBMITTED: "Em validação", VALIDATED: "Validado", REJECTED: "Recusado", CANCELLED: "Retirado" };
export const METHOD_LABELS: Record<PaymentMethod, string> = { TRANSFERENCIA: "Transferência", DEPOSITO: "Depósito" };
export const FUTURE_METHODS: Record<FutureMethod, { label: string; hint: string }> = {
  REFERENCIA: { label: "Pagamento por referência", hint: "Entidade e referência, com confirmação automática." },
  EXPRESS: { label: "Multicaixa Express", hint: "Pedido no telemóvel, com confirmação automática." },
};
export const REQUEST_LABELS: Record<string, string> = { WAITING: "Na lista de espera", CONTACTED: "Em contacto com a EduFlow", DONE: "Pronto", DECLINED: "Não aceite", CANCELLED: "Retirado" };

export const PROOF_MAX_MB = 8;
export const PROOF_FORMATS = ["pdf", "jpg", "png", "webp"];
export const MAX_ITEMS = 30;
export const MAX_ACCOUNTS = 12;

export type PaymentErrorCode =
  | "INVALID_INPUT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "PAYMENTS_OFF"
  | "ACCOUNT_IN_USE"
  | "ACCOUNT_EXISTS"
  | "DUPLICATE_TRANSACTION"
  | "CHARGES_CHANGED"
  | "NEEDS_CONFIRMATION"
  | "INVALID_FILE"
  | "STORAGE_UNAVAILABLE"
  | "PLATFORM_UNAVAILABLE";
export type PaymentError = DomainError<PaymentErrorCode>;
export const paymentError = (code: PaymentErrorCode, message: string, meta?: Record<string, unknown>): PaymentError => new DomainError(code, message, meta);

export const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** "1 250 000 Kz" */
export const kz = (n: number) => `${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Kz`;
export const paymentNumber = (n: number) => `PAG-${String(n).padStart(6, "0")}`;
export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** IBAN sem espaços, em maiúsculas, confirmado (mod-97; Angola: AO + 23 dígitos). */
export function normalizeIban(raw: string): string | null {
  const iban = raw.replace(/[\s.]+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return null;
  if (iban.startsWith("AO") && !/^AO\d{23}$/.test(iban)) return null;
  let rest = 0;
  for (const d of (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1 ? iban : null;
}

export interface BankAccountInput {
  bankName: string;
  holder: string;
  accountNumber?: string | null;
  iban: string;
  notes?: string | null;
  active: boolean;
}
export function checkAccount(i: BankAccountInput): Result<{ bankName: string; holder: string; accountNumber: string | null; iban: string; notes: string | null; active: boolean }, PaymentError> {
  const bankName = clean(i.bankName);
  const holder = clean(i.holder);
  const accountNumber = clean(i.accountNumber) || null;
  const notes = clean(i.notes) || null;
  if (bankName.length < 2 || bankName.length > 60) return fail(paymentError("INVALID_INPUT", "Indique o nome do banco."));
  if (holder.length < 3 || holder.length > 120) return fail(paymentError("INVALID_INPUT", "Indique o titular da conta."));
  if (accountNumber && !/^[\d\s.\-/]{4,30}$/.test(accountNumber)) return fail(paymentError("INVALID_INPUT", "O n.º de conta só leva algarismos."));
  if (notes && notes.length > 200) return fail(paymentError("INVALID_INPUT", "A nota tem no máximo 200 caracteres."));
  const iban = normalizeIban(i.iban);
  if (!iban) return fail(paymentError("INVALID_INPUT", "IBAN inválido. Confira os dígitos (em Angola: AO06 e mais 21 algarismos)."));
  return ok({ bankName, holder, accountNumber, iban, notes, active: i.active });
}

/** A multa de uma propina paga depois do prazo. */
export function lateFee(amount: number, dueOn: string | null, paidOn: string, plan: { kind: LateFeeKind; value: number } | null): number {
  if (!dueOn || !plan || plan.kind === "NONE" || paidOn <= dueOn) return 0;
  return plan.kind === "PERCENT" ? Math.ceil((amount * plan.value) / 100) : plan.value;
}

export interface SubmitInput {
  chargeIds: string[];
  bankAccountId: string;
  method: string;
  transactionNumber: string;
  paidOn: string;
  note?: string | null;
}
export function checkSubmit(i: SubmitInput, today: string): Result<{ chargeIds: string[]; method: PaymentMethod; transactionNumber: string; paidOn: string; note: string | null }, PaymentError> {
  const chargeIds = [...new Set(i.chargeIds)];
  if (!chargeIds.length) return fail(paymentError("INVALID_INPUT", "Escolha o que está a pagar."));
  if (chargeIds.length > MAX_ITEMS) return fail(paymentError("INVALID_INPUT", `No máximo ${MAX_ITEMS} cobranças por pagamento.`));
  if (!(i.method in METHOD_LABELS)) return fail(paymentError("INVALID_INPUT", "Escolha transferência ou depósito."));
  const transactionNumber = clean(i.transactionNumber);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./_-]{2,58}[A-Za-z0-9]$/.test(transactionNumber)) return fail(paymentError("INVALID_INPUT", "Indique o n.º da transação como aparece no comprovativo (4 a 60 caracteres)."));
  if (!isDay(i.paidOn)) return fail(paymentError("INVALID_INPUT", "Indique a data do pagamento."));
  if (i.paidOn > today) return fail(paymentError("INVALID_INPUT", "A data do pagamento não pode ser futura."));
  const note = clean(i.note) || null;
  if (note && note.length > 300) return fail(paymentError("INVALID_INPUT", "A nota tem no máximo 300 caracteres."));
  return ok({ chargeIds, method: i.method as PaymentMethod, transactionNumber, paidOn: i.paidOn, note });
}

export function checkReason(raw: string | null | undefined): Result<string, PaymentError> {
  const t = clean(raw);
  return t.length < 3 || t.length > 300 ? fail(paymentError("INVALID_INPUT", "Indique o motivo (3 a 300 caracteres).")) : ok(t);
}
