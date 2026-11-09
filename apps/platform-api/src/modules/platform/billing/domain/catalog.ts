import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { billingError, type BillingError } from "./errors";

/** Plano de subscrição. */
export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string;
  monthlyPrice: number;
  maxStudents: number | null;
  features: string[];
  active: boolean;
  sortOrder: number;
}

export type PlanInput = Omit<Plan, "id">;

export function validatePlan(input: PlanInput): Result<PlanInput, BillingError> {
  const name = input.name.trim();
  const code = input.code.trim().toUpperCase();
  if (name.length < 2) return fail(billingError("INVALID_PLAN", "O plano precisa de um nome."));
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
    return fail(billingError("INVALID_PLAN", "Código inválido (2–20 letras, números, - ou _)."));
  }
  if (!Number.isInteger(input.monthlyPrice) || input.monthlyPrice <= 0) {
    return fail(billingError("INVALID_PLAN", "O preço mensal tem de ser um valor positivo."));
  }
  if (input.maxStudents !== null && (!Number.isInteger(input.maxStudents) || input.maxStudents < 1)) {
    return fail(billingError("INVALID_PLAN", "O limite de alunos tem de ser um número positivo."));
  }
  return ok({
    ...input,
    name,
    code,
    description: input.description.trim(),
    features: input.features.map((f) => f.trim()).filter(Boolean),
  });
}

/** Definições de faturação (uma por plataforma). */
export interface BillingSettings {
  quarterlyDiscountPct: number;
  annualDiscountPct: number;
  /** Entidade usada nas referências de pagamento. */
  referenceEntity: string;
  referenceProvider: string;
  referenceValidityDays: number;
  /** Texto extra mostrado ao colégio quando paga por transferência. */
  transferInstructions: string | null;
}

export function validateSettings(input: BillingSettings): Result<BillingSettings, BillingError> {
  const pct = (v: number) => Number.isInteger(v) && v >= 0 && v <= 90;
  if (!pct(input.quarterlyDiscountPct) || !pct(input.annualDiscountPct)) {
    return fail(billingError("INVALID_SETTINGS", "Os descontos têm de estar entre 0% e 90%."));
  }
  if (!/^\d{5}$/.test(input.referenceEntity)) {
    return fail(billingError("INVALID_SETTINGS", "A entidade tem de ter 5 dígitos."));
  }
  if (!Number.isInteger(input.referenceValidityDays) || input.referenceValidityDays < 1 || input.referenceValidityDays > 30) {
    return fail(billingError("INVALID_SETTINGS", "A validade da referência tem de estar entre 1 e 30 dias."));
  }
  return ok({
    ...input,
    referenceProvider: input.referenceProvider.trim() || "Multicaixa",
    transferInstructions: input.transferInstructions?.trim() || null,
  });
}

/** Conta bancária da EduFlow para receber transferências. */
export interface BankAccount {
  id: string;
  bankName: string;
  holder: string;
  iban: string;
  swift: string | null;
  active: boolean;
}

export type BankAccountInput = Omit<BankAccount, "id">;

/** IBAN normalizado (sem espaços, maiúsculas) e validado pelo algoritmo mod-97. */
export function normalizeIban(raw: string): string | null {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return null;
  // Angola: AO + 2 dígitos de controlo + 21 dígitos = 25 caracteres
  if (iban.startsWith("AO") && !/^AO\d{23}$/.test(iban)) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1 ? iban : null;
}

export function validateBankAccount(input: BankAccountInput): Result<BankAccountInput, BillingError> {
  const bankName = input.bankName.trim();
  const holder = input.holder.trim();
  if (bankName.length < 2) return fail(billingError("INVALID_BANK_ACCOUNT", "Indique o nome do banco."));
  if (holder.length < 3) return fail(billingError("INVALID_BANK_ACCOUNT", "Indique o titular da conta."));
  const iban = normalizeIban(input.iban);
  if (!iban) return fail(billingError("INVALID_BANK_ACCOUNT", "IBAN inválido. Confira os dígitos."));
  const swift = input.swift?.replace(/\s+/g, "").toUpperCase() || null;
  if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) {
    return fail(billingError("INVALID_BANK_ACCOUNT", "Código SWIFT/BIC inválido."));
  }
  return ok({ bankName, holder, iban, swift, active: input.active });
}

export interface BillingRepository {
  listPlans(options?: { onlyActive?: boolean }): Promise<Plan[]>;
  findPlan(id: string): Promise<Plan | null>;
  savePlan(plan: Plan): Promise<void>;
  planCodeExists(code: string, exceptId?: string): Promise<boolean>;

  getSettings(): Promise<BillingSettings>;
  saveSettings(settings: BillingSettings): Promise<void>;

  listBankAccounts(options?: { onlyActive?: boolean }): Promise<BankAccount[]>;
  findBankAccount(id: string): Promise<BankAccount | null>;
  saveBankAccount(account: BankAccount): Promise<void>;
  deleteBankAccount(id: string): Promise<void>;
  ibanExists(iban: string, exceptId?: string): Promise<boolean>;
}
