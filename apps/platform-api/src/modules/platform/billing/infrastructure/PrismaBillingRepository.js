"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaBillingRepository = void 0;
const node_crypto_1 = require("node:crypto");
const DEFAULT_SETTINGS = {
    quarterlyDiscountPct: 5,
    annualDiscountPct: 15,
    referenceEntity: "11223",
    referenceProvider: "Multicaixa (simulado)",
    referenceValidityDays: 3,
    transferInstructions: "Indique o número do pedido no descritivo da transferência.",
};
const DEFAULT_PLANS = [
    {
        code: "ESSENCIAL",
        name: "Essencial",
        description: "Para colégios pequenos que estão a começar a digitalizar a gestão.",
        monthlyPrice: 45_000,
        maxStudents: 300,
        features: ["Matrículas e turmas", "Pautas e avaliações", "Propinas", "Suporte por email"],
        active: true,
        sortOrder: 1,
    },
    {
        code: "PROFISSIONAL",
        name: "Profissional",
        description: "O mais escolhido — gestão completa para colégios em crescimento.",
        monthlyPrice: 95_000,
        maxStudents: 1_000,
        features: ["Tudo do Essencial", "Horários", "Comunicação com encarregados", "Relatórios", "Suporte prioritário"],
        active: true,
        sortOrder: 2,
    },
    {
        code: "PREMIUM",
        name: "Premium",
        description: "Para grandes colégios e grupos com várias unidades.",
        monthlyPrice: 180_000,
        maxStudents: null,
        features: ["Tudo do Profissional", "Alunos ilimitados", "Exportações avançadas", "Gestor de conta dedicado"],
        active: true,
        sortOrder: 3,
    },
];
class PrismaBillingRepository {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async ensureDefaults() {
        await this.prisma.billingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...DEFAULT_SETTINGS }, update: {} });
        if ((await this.prisma.plan.count()) === 0) {
            await this.prisma.plan.createMany({ data: DEFAULT_PLANS.map((p) => ({ id: (0, node_crypto_1.randomUUID)(), ...p })) });
        }
    }
    listPlans(options = {}) {
        return this.prisma.plan.findMany({
            where: options.onlyActive ? { active: true } : undefined,
            orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
            select: planSelect,
        });
    }
    findPlan(id) {
        return this.prisma.plan.findUnique({ where: { id }, select: planSelect });
    }
    async savePlan(plan) {
        const { id, ...data } = plan;
        await this.prisma.plan.upsert({ where: { id }, create: plan, update: data });
    }
    async planCodeExists(code, exceptId) {
        return (await this.prisma.plan.count({ where: { code, NOT: exceptId ? { id: exceptId } : undefined } })) > 0;
    }
    async getSettings() {
        const row = await this.prisma.billingSettings.findUnique({ where: { id: 1 } });
        if (!row)
            return DEFAULT_SETTINGS;
        const { id: _id, updatedAt: _u, ...settings } = row;
        return settings;
    }
    async saveSettings(settings) {
        await this.prisma.billingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
    }
    listBankAccounts(options = {}) {
        return this.prisma.bankAccount.findMany({
            where: options.onlyActive ? { active: true } : undefined,
            orderBy: [{ active: "desc" }, { bankName: "asc" }],
            select: bankSelect,
        });
    }
    findBankAccount(id) {
        return this.prisma.bankAccount.findUnique({ where: { id }, select: bankSelect });
    }
    async saveBankAccount(account) {
        const { id, ...data } = account;
        await this.prisma.bankAccount.upsert({ where: { id }, create: account, update: data });
    }
    async deleteBankAccount(id) {
        await this.prisma.bankAccount.delete({ where: { id } });
    }
    async ibanExists(iban, exceptId) {
        return (await this.prisma.bankAccount.count({ where: { iban, NOT: exceptId ? { id: exceptId } : undefined } })) > 0;
    }
}
exports.PrismaBillingRepository = PrismaBillingRepository;
const planSelect = {
    id: true,
    code: true,
    name: true,
    description: true,
    monthlyPrice: true,
    maxStudents: true,
    features: true,
    active: true,
    sortOrder: true,
};
const bankSelect = { id: true, bankName: true, holder: true, iban: true, swift: true, active: true };
//# sourceMappingURL=PrismaBillingRepository.js.map