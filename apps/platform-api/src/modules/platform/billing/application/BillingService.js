"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingService = void 0;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const catalog_1 = require("../domain/catalog");
const errors_1 = require("../domain/errors");
const pricing_1 = require("../domain/pricing");
class BillingService {
    repo;
    ids;
    constructor(repo, ids) {
        this.repo = repo;
        this.ids = ids;
    }
    async publicCatalog() {
        const [plans, settings] = await Promise.all([this.repo.listPlans({ onlyActive: true }), this.repo.getSettings()]);
        return {
            plans,
            discounts: { quarterlyPct: settings.quarterlyDiscountPct, annualPct: settings.annualDiscountPct },
        };
    }
    async quote(planId, cycleInput) {
        const plan = await this.repo.findPlan(planId);
        if (!plan)
            return (0, Result_1.fail)((0, errors_1.billingError)("PLAN_NOT_FOUND", "Plano não encontrado."));
        if (!plan.active)
            return (0, Result_1.fail)((0, errors_1.billingError)("PLAN_INACTIVE", "Este plano já não está disponível."));
        const cycle = (0, pricing_1.createCycle)(cycleInput);
        if (!cycle.ok)
            return cycle;
        const settings = await this.repo.getSettings();
        return (0, Result_1.ok)({
            ...(0, pricing_1.quote)(plan.monthlyPrice, cycle.value, settings),
            plan: { id: plan.id, code: plan.code, name: plan.name, monthlyPrice: plan.monthlyPrice },
            cycle: cycle.value,
            cycleLabel: (0, pricing_1.describeCycle)(cycle.value),
        });
    }
    getSettings() {
        return this.repo.getSettings();
    }
    async updateSettings(input) {
        const valid = (0, catalog_1.validateSettings)(input);
        if (!valid.ok)
            return valid;
        await this.repo.saveSettings(valid.value);
        return (0, Result_1.ok)(valid.value);
    }
    listPlans() {
        return this.repo.listPlans();
    }
    async createPlan(input) {
        const valid = (0, catalog_1.validatePlan)(input);
        if (!valid.ok)
            return valid;
        if (await this.repo.planCodeExists(valid.value.code)) {
            return (0, Result_1.fail)((0, errors_1.billingError)("DUPLICATE", "Já existe um plano com este código."));
        }
        const plan = { id: this.ids.next(), ...valid.value };
        await this.repo.savePlan(plan);
        return (0, Result_1.ok)(plan);
    }
    async updatePlan(id, input) {
        if (!(await this.repo.findPlan(id)))
            return (0, Result_1.fail)((0, errors_1.billingError)("PLAN_NOT_FOUND", "Plano não encontrado."));
        const valid = (0, catalog_1.validatePlan)(input);
        if (!valid.ok)
            return valid;
        if (await this.repo.planCodeExists(valid.value.code, id)) {
            return (0, Result_1.fail)((0, errors_1.billingError)("DUPLICATE", "Já existe um plano com este código."));
        }
        const plan = { id, ...valid.value };
        await this.repo.savePlan(plan);
        return (0, Result_1.ok)(plan);
    }
    listBankAccounts(onlyActive = false) {
        return this.repo.listBankAccounts({ onlyActive });
    }
    findBankAccount(id) {
        return this.repo.findBankAccount(id);
    }
    async createBankAccount(input) {
        const valid = (0, catalog_1.validateBankAccount)(input);
        if (!valid.ok)
            return valid;
        if (await this.repo.ibanExists(valid.value.iban)) {
            return (0, Result_1.fail)((0, errors_1.billingError)("DUPLICATE", "Esta conta (IBAN) já está registada."));
        }
        const account = { id: this.ids.next(), ...valid.value };
        await this.repo.saveBankAccount(account);
        return (0, Result_1.ok)(account);
    }
    async updateBankAccount(id, input) {
        if (!(await this.repo.findBankAccount(id))) {
            return (0, Result_1.fail)((0, errors_1.billingError)("BANK_ACCOUNT_NOT_FOUND", "Conta bancária não encontrada."));
        }
        const valid = (0, catalog_1.validateBankAccount)(input);
        if (!valid.ok)
            return valid;
        if (await this.repo.ibanExists(valid.value.iban, id)) {
            return (0, Result_1.fail)((0, errors_1.billingError)("DUPLICATE", "Esta conta (IBAN) já está registada."));
        }
        const account = { id, ...valid.value };
        await this.repo.saveBankAccount(account);
        return (0, Result_1.ok)(account);
    }
    async deleteBankAccount(id) {
        if (!(await this.repo.findBankAccount(id))) {
            return (0, Result_1.fail)((0, errors_1.billingError)("BANK_ACCOUNT_NOT_FOUND", "Conta bancária não encontrada."));
        }
        await this.repo.deleteBankAccount(id);
        return (0, Result_1.ok)(undefined);
    }
}
exports.BillingService = BillingService;
//# sourceMappingURL=BillingService.js.map