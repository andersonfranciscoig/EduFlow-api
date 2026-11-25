import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { clean, isDay, type PaymentError, paymentError } from "./payments";

/**
 * DESPESAS do colégio:  PENDING (por pagar) ──pagar──▶ PAID
 *                           │                    └─ repor (motivo) ─▶ PENDING
 *                           └─ anular (motivo) ─▶ CANCELLED
 * Nunca se apagam: anulam-se, com motivo, e ficam no histórico.
 */
export type ExpenseStatus = "PENDING" | "PAID" | "CANCELLED";
export const EXPENSE_LABELS: Record<ExpenseStatus, string> = { PENDING: "Por pagar", PAID: "Paga", CANCELLED: "Anulada" };
export const EXPENSE_METHODS = { TRANSFERENCIA: "Transferência", DEPOSITO: "Depósito", NUMERARIO: "Numerário", CHEQUE: "Cheque", OUTRO: "Outro" } as const;
export type ExpenseMethod = keyof typeof EXPENSE_METHODS;
export const EXPENSE_SUGGESTIONS = ["Salários", "Renda", "Água", "Energia", "Internet e telefone", "Material escolar", "Material de escritório", "Limpeza", "Manutenção e obras", "Transporte", "Impostos e taxas", "Outras despesas"];
export const MAX_CATEGORIES = 40;
export const expenseNumber = (n: number) => `DES-${String(n).padStart(6, "0")}`;

export interface ExpenseInput {
  categoryId: string;
  description: string;
  supplier?: string | null;
  documentNumber?: string | null;
  amount: number;
  issuedOn: string;
  dueOn?: string | null;
  note?: string | null;
}
export type ExpenseData = { categoryId: string; description: string; supplier: string | null; documentNumber: string | null; amount: number; issuedOn: string; dueOn: string | null; note: string | null };

const bad = (m: string) => fail(paymentError("INVALID_INPUT", m));
export function checkExpense(i: ExpenseInput, today: string): Result<ExpenseData, PaymentError> {
  const description = clean(i.description);
  const supplier = clean(i.supplier) || null;
  const documentNumber = clean(i.documentNumber) || null;
  const note = clean(i.note) || null;
  if (description.length < 3 || description.length > 120) return bad("Descreva a despesa (3 a 120 caracteres).");
  if (supplier && supplier.length > 120) return bad("O fornecedor tem no máximo 120 caracteres.");
  if (documentNumber && documentNumber.length > 60) return bad("O n.º da fatura tem no máximo 60 caracteres.");
  if (note && note.length > 300) return bad("A nota tem no máximo 300 caracteres.");
  if (!Number.isInteger(i.amount) || i.amount < 1 || i.amount > 1_000_000_000) return bad("Indique o valor em kwanzas, sem cêntimos.");
  if (!isDay(i.issuedOn)) return bad("Indique a data da despesa.");
  if (i.issuedOn > today) return bad("A data da despesa não pode ser futura.");
  const dueOn = i.dueOn || null;
  if (dueOn && !isDay(dueOn)) return bad("A data limite não é válida.");
  if (dueOn && dueOn < i.issuedOn) return bad("A data limite não pode ser anterior à da despesa.");
  return ok({ categoryId: i.categoryId, description, supplier, documentNumber, amount: i.amount, issuedOn: i.issuedOn, dueOn, note });
}

export interface PayInput {
  paidOn: string;
  method: string;
  bankAccountId?: string | null;
  transactionNumber?: string | null;
}
export function checkPay(i: PayInput, issuedOn: string, today: string): Result<{ paidOn: string; method: ExpenseMethod; bankAccountId: string | null; transactionNumber: string | null }, PaymentError> {
  if (!(i.method in EXPENSE_METHODS)) return bad("Escolha como foi paga.");
  if (!isDay(i.paidOn)) return bad("Indique a data do pagamento.");
  if (i.paidOn > today) return bad("A data do pagamento não pode ser futura.");
  if (i.paidOn < issuedOn) return bad("A data do pagamento não pode ser anterior à da despesa.");
  const transactionNumber = clean(i.transactionNumber) || null;
  if (transactionNumber && transactionNumber.length > 60) return bad("O n.º da transação tem no máximo 60 caracteres.");
  return ok({ paidOn: i.paidOn, method: i.method as ExpenseMethod, bankAccountId: i.bankAccountId || null, transactionNumber });
}
