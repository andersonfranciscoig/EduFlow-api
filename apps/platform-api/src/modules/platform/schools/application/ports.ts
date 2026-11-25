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
  listBankAccounts(onlyActive?: boolean): Promise<{ id: string; bankName: string; holder: string; iban: string; active: boolean }[]>;
  findBankAccount(id: string): Promise<{ id: string; bankName: string; holder: string; iban: string; active: boolean } | null>;
}

/**
 * Porta para o contexto "databases": onde fica a BD do colégio.
 * choice: "auto" | id do servidor | null (decidir depois).
 */
export interface SchoolDatabasePort {
  reserveOnApproval(schoolId: string, choice: string | null, staffId: string): Promise<Result<unknown, DomainError>>;
  release(schoolId: string, reason: string, staffId: string | null): Promise<unknown>;
  status(schoolId: string): Promise<unknown>;
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
  /** Endereço do portal de cada colégio ({slug}). */
  portalUrlTemplate: string;
  /** Pagamento por referência ligado (ainda não: chega em breve). */
  referencePayments: boolean;
}

/** Avisos por email ao responsável (melhor esforço: nunca falha a operação). */
export interface SchoolNotifier {
  schoolActivated(input: { to: { email: string; name: string }; schoolName: string; portalUrl: string; subscriptionEndsAt: Date | null }): Promise<void>;
  schoolSuspended(input: { to: { email: string; name: string }; schoolName: string; reason: string }): Promise<void>;
  /** Estado do pagamento da subscrição (ao responsável do colégio). */
  paymentUpdate(input: { to: { email: string; name: string }; schoolName: string; state: "OPEN" | "SUBMITTED" | "REJECTED" | "CONFIRMED"; orderNumber: string; total: number; reason?: string }): Promise<void>;
  /** À equipa EduFlow que gere a faturação: há um pagamento para validar, ou mudou de estado. */
  teamPaymentUpdate(input: { to: { email: string; name: string }[]; schoolId: string; schoolName: string; state: "SUBMITTED" | "REJECTED" | "CONFIRMED"; orderNumber: string; total: number; detail: string }): Promise<void>;
  /** A resposta da EduFlow a um pedido de pagamento por referência/Express. */
  integrationUpdate(input: { to: { email: string; name: string }; schoolName: string; methodLabel: string; status: "CONTACTED" | "DONE" | "DECLINED"; note: string | null }): Promise<void>;
}

/** Quem da equipa EduFlow trata dos pagamentos (contas ativas com billing.manage). */
export interface BillingTeam {
  emails(): Promise<{ email: string; name: string }[]>;
}

/** Bilhetes de suporte (assinados com a chave privada que só a plataforma tem). */
export interface SupportTicketIssuer {
  issue(input: {
    staffId: string;
    staffName: string;
    schoolId: string;
    mode: "READ" | "WRITE";
    emergency: boolean;
    reason: string;
    ttlSeconds: number;
  }): Promise<string>;
}

/** Onde ficam os logótipos (ficheiros PÚBLICOS: qualquer pessoa com o URL os vê). */
export interface LogoStorage {
  readonly name: string;
  put(schoolId: string, file: { mimeType: string; content: Buffer }): Promise<{ key: string; url: string }>;
  remove(key: string): Promise<void>;
  /** Só quando é esta API a servir os ficheiros (pasta local). */
  read?(key: string): Promise<{ content: Buffer; mimeType: string } | null>;
}

export const SCHOOL_TOKENS = {
  SchoolRepository: Symbol("SchoolRepository"),
  PlanCatalog: Symbol("PlanCatalog"),
  SchoolTokenService: Symbol("SchoolTokenService"),
  CodeGenerator: Symbol("CodeGenerator"),
  SchoolSettings: Symbol("SchoolSettings"),
  SchoolDatabases: Symbol("SchoolDatabases"),
  SchoolNotifier: Symbol("SchoolNotifier"),
  BillingTeam: Symbol("BillingTeam"),
  LogoStorage: Symbol("LogoStorage"),
  SupportTicketIssuer: Symbol("SupportTicketIssuer"),
} as const;
