import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * PREÇÁRIO do colégio.
 *   rubrica      tipo de cobrança (Propina mensal, Matrícula, Confirmação, Uniforme…)
 *   preço        valor de uma rubrica numa classe do ano letivo (no II Ciclo, a classe já é por curso)
 *   calendário   meses em que a propina é cobrada, dia limite e multa por atraso
 *
 * Valores em kwanzas, inteiros. Ano encerrado: só leitura.
 */
export type Billing = "MENSAL" | "UNICA";
export type AppliesTo = "TODOS" | "NOVOS" | "CONTINUANTES";
export type LateFeeKind = "NONE" | "PERCENT" | "FIXED";

export const BILLING_LABELS: Record<Billing, string> = { MENSAL: "Mensal", UNICA: "Única" };
export const APPLIES_LABELS: Record<AppliesTo, string> = { TODOS: "Todos os alunos", NOVOS: "Alunos novos", CONTINUANTES: "Alunos que continuam" };

// As rubricas de partida (Propina mensal, Matrícula para novos, Confirmação para quem continua)
// são criadas pela migração 0009_pricing.

export const MAX_AMOUNT = 100_000_000;
export const MAX_FEE_ITEMS = 20;

export type FinanceErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "YEAR_NOT_FOUND"
  | "YEAR_CLOSED"
  | "CLASS_NOT_FOUND"
  | "FEE_ITEM_NOT_FOUND"
  | "FEE_ITEM_EXISTS"
  | "FEE_ITEM_IN_USE"
  | "FEE_ITEM_ARCHIVED"
  | "FEE_ITEM_LIMIT";

export type FinanceError = DomainError<FinanceErrorCode>;
export const financeError = (code: FinanceErrorCode, message: string, meta?: Record<string, unknown>): FinanceError => new DomainError(code, message, meta);

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || "";

export interface FeeItemInput {
  name: string;
  billing: Billing;
  appliesTo: AppliesTo;
}

export function checkFeeItem(input: { name: string; billing: string; appliesTo?: string | null }): Result<FeeItemInput, FinanceError> {
  const name = clean(input.name);
  if (name.length < 2) return fail(financeError("INVALID_INPUT", "Indique o nome da rubrica."));
  if (name.length > 40) return fail(financeError("INVALID_INPUT", "O nome da rubrica tem no máximo 40 caracteres."));
  if (!(input.billing in BILLING_LABELS)) return fail(financeError("INVALID_INPUT", "Escolha se a rubrica é mensal ou única."));
  const appliesTo = input.appliesTo ?? "TODOS";
  if (!(appliesTo in APPLIES_LABELS)) return fail(financeError("INVALID_INPUT", "Escolha a quem se aplica a rubrica."));
  return ok({ name, billing: input.billing as Billing, appliesTo: appliesTo as AppliesTo });
}

export interface PriceInput {
  classId: string;
  feeItemId: string;
  /** null = sem preço (retira) */
  amount: number | null;
}

/** Preços a gravar: cada (classe, rubrica) uma vez; 0 a 100 000 000 Kz. */
export function checkPrices(items: PriceInput[]): Result<PriceInput[], FinanceError> {
  const seen = new Set<string>();
  for (const it of items) {
    const key = `${it.classId}:${it.feeItemId}`;
    if (seen.has(key)) return fail(financeError("INVALID_INPUT", "O mesmo preço aparece duas vezes."));
    seen.add(key);
    if (it.amount !== null && (!Number.isInteger(it.amount) || it.amount < 0 || it.amount > MAX_AMOUNT))
      return fail(financeError("INVALID_INPUT", "Os valores são em kwanzas, sem casas decimais, até 100 000 000 Kz."));
  }
  return ok(items);
}

// ================================================================ calendário das propinas

/** "2026-09" */
export const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** Meses do ano letivo, do mês de início ao mês de fim (ex.: set → jul = 11). */
export function yearMonths(startsOn: Date, endsOn: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(startsOn.getUTCFullYear(), startsOn.getUTCMonth(), 1));
  const last = monthKey(endsOn);
  while (out.length < 24) {
    const k = monthKey(d);
    out.push(k);
    if (k === last) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

export interface FeePlanInput {
  months: string[];
  dueDay: number;
  lateFee: { kind: LateFeeKind; value: number };
}

export function checkFeePlan(input: FeePlanInput, allowed: string[]): Result<FeePlanInput, FinanceError> {
  const months = [...new Set(input.months)];
  if (!months.length) return fail(financeError("INVALID_INPUT", "Escolha pelo menos um mês de propina."));
  const outside = months.find((m) => !allowed.includes(m));
  if (outside) return fail(financeError("INVALID_INPUT", "Os meses da propina têm de estar dentro do ano letivo."));
  if (!Number.isInteger(input.dueDay) || input.dueDay < 1 || input.dueDay > 28) return fail(financeError("INVALID_INPUT", "O dia limite vai de 1 a 28."));
  const { kind, value } = input.lateFee;
  if (kind === "NONE") return ok({ months: allowed.filter((m) => months.includes(m)), dueDay: input.dueDay, lateFee: { kind, value: 0 } });
  if (!Number.isInteger(value)) return fail(financeError("INVALID_INPUT", "A multa é um número inteiro."));
  if (kind === "PERCENT" && (value < 1 || value > 100)) return fail(financeError("INVALID_INPUT", "A multa em percentagem vai de 1% a 100%."));
  if (kind === "FIXED" && (value < 1 || value > 10_000_000)) return fail(financeError("INVALID_INPUT", "A multa fixa vai de 1 a 10 000 000 Kz."));
  if (kind !== "PERCENT" && kind !== "FIXED") return fail(financeError("INVALID_INPUT", "Tipo de multa inválido."));
  return ok({ months: allowed.filter((m) => months.includes(m)), dueDay: input.dueDay, lateFee: { kind, value } });
}

/**
 * Total anual de uma classe para um aluno novo ou um que continua:
 * rubricas mensais × meses cobrados + rubricas únicas (só as que se aplicam a esse aluno).
 */
export function annualTotal(prices: { billing: Billing; appliesTo: AppliesTo; amount: number }[], months: number, student: "NOVOS" | "CONTINUANTES") {
  return prices
    .filter((p) => p.appliesTo === "TODOS" || p.appliesTo === student)
    .reduce((n, p) => n + (p.billing === "MENSAL" ? p.amount * months : p.amount), 0);
}
