import type { IdGenerator } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import {
  type BankAccount,
  type BankAccountInput,
  type BillingRepository,
  type BillingSettings,
  type Plan,
  type PlanInput,
  validateBankAccount,
  validatePlan,
  validateSettings,
} from "../domain/catalog";
import { billingError, type BillingError } from "../domain/errors";
import { type BillingCycle, createCycle, type CycleKind, describeCycle, quote, type Quote } from "../domain/pricing";

export interface CycleInput {
  kind: CycleKind;
  quantity?: number;
  unit?: "MONTHS" | "YEARS";
}

export interface PlanQuote extends Quote {
  plan: Pick<Plan, "id" | "code" | "name" | "monthlyPrice">;
  cycle: BillingCycle;
  cycleLabel: string;
}

/**
 * Serviço de aplicação da faturação (catálogo, preços, definições, contas).
 * Também é usado pelo contexto "schools" através da porta PlanCatalog.
 */
export class BillingService {
  constructor(
    private readonly repo: BillingRepository,
    private readonly ids: IdGenerator,
  ) {}

  // ------------------------------------------------------------------ público

  async publicCatalog() {
    const [plans, settings] = await Promise.all([this.repo.listPlans({ onlyActive: true }), this.repo.getSettings()]);
    return {
      plans,
      discounts: { quarterlyPct: settings.quarterlyDiscountPct, annualPct: settings.annualDiscountPct },
    };
  }

  async quote(planId: string, cycleInput: CycleInput): Promise<Result<PlanQuote, BillingError>> {
    const plan = await this.repo.findPlan(planId);
    if (!plan) return fail(billingError("PLAN_NOT_FOUND", "Plano não encontrado."));
    if (!plan.active) return fail(billingError("PLAN_INACTIVE", "Este plano já não está disponível."));
    const cycle = createCycle(cycleInput);
    if (!cycle.ok) return cycle;
    const settings = await this.repo.getSettings();
    return ok({
      ...quote(plan.monthlyPrice, cycle.value, settings),
      plan: { id: plan.id, code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice },
      cycle: cycle.value,
      cycleLabel: describeCycle(cycle.value),
    });
  }

  // ------------------------------------------------------------------ definições

  getSettings() {
    return this.repo.getSettings();
  }

  async updateSettings(input: BillingSettings): Promise<Result<BillingSettings, BillingError>> {
    const valid = validateSettings(input);
    if (!valid.ok) return valid;
    await this.repo.saveSettings(valid.value);
    return ok(valid.value);
  }

  // ------------------------------------------------------------------ planos

  listPlans() {
    return this.repo.listPlans();
  }

  async createPlan(input: PlanInput): Promise<Result<Plan, BillingError>> {
    const valid = validatePlan(input);
    if (!valid.ok) return valid;
    if (await this.repo.planCodeExists(valid.value.code)) {
      return fail(billingError("DUPLICATE", "Já existe um plano com este código."));
    }
    const plan = { id: this.ids.next(), ...valid.value };
    await this.repo.savePlan(plan);
    return ok(plan);
  }

  async updatePlan(id: string, input: PlanInput): Promise<Result<Plan, BillingError>> {
    if (!(await this.repo.findPlan(id))) return fail(billingError("PLAN_NOT_FOUND", "Plano não encontrado."));
    const valid = validatePlan(input);
    if (!valid.ok) return valid;
    if (await this.repo.planCodeExists(valid.value.code, id)) {
      return fail(billingError("DUPLICATE", "Já existe um plano com este código."));
    }
    const plan = { id, ...valid.value };
    await this.repo.savePlan(plan);
    return ok(plan);
  }

  // ------------------------------------------------------------------ contas bancárias

  listBankAccounts(onlyActive = false) {
    return this.repo.listBankAccounts({ onlyActive });
  }

  findBankAccount(id: string) {
    return this.repo.findBankAccount(id);
  }

  async createBankAccount(input: BankAccountInput): Promise<Result<BankAccount, BillingError>> {
    const valid = validateBankAccount(input);
    if (!valid.ok) return valid;
    if (await this.repo.ibanExists(valid.value.iban)) {
      return fail(billingError("DUPLICATE", "Esta conta (IBAN) já está registada."));
    }
    const account = { id: this.ids.next(), ...valid.value };
    await this.repo.saveBankAccount(account);
    return ok(account);
  }

  async updateBankAccount(id: string, input: BankAccountInput): Promise<Result<BankAccount, BillingError>> {
    if (!(await this.repo.findBankAccount(id))) {
      return fail(billingError("BANK_ACCOUNT_NOT_FOUND", "Conta bancária não encontrada."));
    }
    const valid = validateBankAccount(input);
    if (!valid.ok) return valid;
    if (await this.repo.ibanExists(valid.value.iban, id)) {
      return fail(billingError("DUPLICATE", "Esta conta (IBAN) já está registada."));
    }
    const account = { id, ...valid.value };
    await this.repo.saveBankAccount(account);
    return ok(account);
  }

  async deleteBankAccount(id: string): Promise<Result<void, BillingError>> {
    if (!(await this.repo.findBankAccount(id))) {
      return fail(billingError("BANK_ACCOUNT_NOT_FOUND", "Conta bancária não encontrada."));
    }
    await this.repo.deleteBankAccount(id);
    return ok(undefined);
  }
}
