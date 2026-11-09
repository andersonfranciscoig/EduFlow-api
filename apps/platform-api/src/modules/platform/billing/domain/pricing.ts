import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { billingError, type BillingError } from "./errors";

/**
 * Periodicidade de pagamento da subscrição.
 * - MONTHLY / QUARTERLY / ANNUAL: 1, 3 e 12 meses;
 * - CUSTOM: o colégio escolhe N meses (1–36) ou N anos (1–5).
 */
export const CYCLE_KINDS = ["MONTHLY", "QUARTERLY", "ANNUAL", "CUSTOM"] as const;
export type CycleKind = (typeof CYCLE_KINDS)[number];

export interface BillingCycle {
  kind: CycleKind;
  months: number;
}

export const MAX_CUSTOM_MONTHS = 36;
export const MAX_CUSTOM_YEARS = 5;

export function createCycle(input: {
  kind: CycleKind;
  /** Só para CUSTOM. */
  quantity?: number;
  unit?: "MONTHS" | "YEARS";
}): Result<BillingCycle, BillingError> {
  switch (input.kind) {
    case "MONTHLY":
      return ok({ kind: "MONTHLY", months: 1 });
    case "QUARTERLY":
      return ok({ kind: "QUARTERLY", months: 3 });
    case "ANNUAL":
      return ok({ kind: "ANNUAL", months: 12 });
    case "CUSTOM": {
      const q = input.quantity ?? 0;
      const unit = input.unit ?? "MONTHS";
      const max = unit === "YEARS" ? MAX_CUSTOM_YEARS : MAX_CUSTOM_MONTHS;
      if (!Number.isInteger(q) || q < 1 || q > max) {
        return fail(
          billingError(
            "INVALID_CYCLE",
            unit === "YEARS" ? `Escolha entre 1 e ${MAX_CUSTOM_YEARS} anos.` : `Escolha entre 1 e ${MAX_CUSTOM_MONTHS} meses.`,
          ),
        );
      }
      return ok({ kind: "CUSTOM", months: unit === "YEARS" ? q * 12 : q });
    }
    default:
      return fail(billingError("INVALID_CYCLE", "Periodicidade inválida."));
  }
}

export interface DiscountPolicy {
  quarterlyDiscountPct: number;
  annualDiscountPct: number;
}

export interface Quote {
  months: number;
  monthlyPrice: number;
  subtotal: number;
  discountPct: number;
  discount: number;
  total: number;
}

/**
 * Política de preço: desconto trimestral a partir de 3 meses e anual a partir
 * de 12 meses (o melhor que se aplicar). Vale também para o personalizado.
 */
export function quote(monthlyPrice: number, cycle: BillingCycle, policy: DiscountPolicy): Quote {
  const discountPct =
    cycle.months >= 12 ? policy.annualDiscountPct : cycle.months >= 3 ? policy.quarterlyDiscountPct : 0;
  const subtotal = monthlyPrice * cycle.months;
  const discount = Math.round((subtotal * discountPct) / 100);
  return { months: cycle.months, monthlyPrice, subtotal, discountPct, discount, total: subtotal - discount };
}

export function describeCycle(cycle: BillingCycle): string {
  if (cycle.kind === "MONTHLY") return "Mensal";
  if (cycle.kind === "QUARTERLY") return "Trimestral";
  if (cycle.kind === "ANNUAL") return "Anual";
  return cycle.months % 12 === 0
    ? `${cycle.months / 12} ano${cycle.months === 12 ? "" : "s"}`
    : `${cycle.months} ${cycle.months === 1 ? "mês" : "meses"}`;
}
