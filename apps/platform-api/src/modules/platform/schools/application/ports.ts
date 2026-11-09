import type { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";
import type { Result } from "../../../../../../../libs/kernel/src/domain/Result";

/**
 * Porta para o contexto de faturação (anti-corruption layer):
 * o contexto "schools" só conhece estes formatos mínimos.
 */
export interface PlanCatalog {
  quote(
    planId: string,
    cycle: { kind: "MONTHLY" | "QUARTERLY" | "ANNUAL" | "CUSTOM"; quantity?: number; unit?: "MONTHS" | "YEARS" },
  ): Promise<
    Result<
      {
        plan: { id: string; name: string; monthlyPrice: number };
        cycle: { kind: string; months: number };
        cycleLabel: string;
        subtotal: number;
        discountPct: number;
        total: number;
      },
      DomainError
    >
  >;
  getSettings(): Promise<{
    referenceEntity: string;
    referenceProvider: string;
    referenceValidityDays: number;
    transferInstructions: string | null;
  }>;
  findBankAccount(id: string): Promise<{ id: string; bankName: string; holder: string; iban: string; active: boolean } | null>;
}

export interface SchoolTokenService {
  issue(schoolId: string): Promise<{ accessToken: string; expiresIn: number }>;
  verify(token: string): Promise<string | null>;
}

export interface CodeGenerator {
  /** Ex.: EF-261109-48213 */
  orderNumber(now: Date): string;
  /** 9 dígitos. */
  referenceNumber(): string;
}

export interface SchoolSettings {
  defaultPhoneCountryCode: string;
}

export const SCHOOL_TOKENS = {
  SchoolRepository: Symbol("SchoolRepository"),
  PlanCatalog: Symbol("PlanCatalog"),
  SchoolTokenService: Symbol("SchoolTokenService"),
  CodeGenerator: Symbol("CodeGenerator"),
  SchoolSettings: Symbol("SchoolSettings"),
} as const;
