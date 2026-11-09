import { randomUUID } from "node:crypto";
import type { PrismaClient } from ".prisma/platform-client";
import type { BankAccount, BillingRepository, BillingSettings, Plan } from "../domain/catalog";

/** Valores iniciais — criados uma vez, editáveis depois em Faturação. */
const DEFAULT_SETTINGS: BillingSettings = {
  quarterlyDiscountPct: 5,
  annualDiscountPct: 15,
  referenceEntity: "11223",
  referenceProvider: "Multicaixa (simulado)",
  referenceValidityDays: 3,
  transferInstructions: "Indique o número do pedido no descritivo da transferência.",
};

const DEFAULT_PLANS: Omit<Plan, "id">[] = [
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

export class PrismaBillingRepository implements BillingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Garante definições e planos iniciais (idempotente). */
  async ensureDefaults() {
    await this.prisma.billingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...DEFAULT_SETTINGS }, update: {} });
    if ((await this.prisma.plan.count()) === 0) {
      await this.prisma.plan.createMany({ data: DEFAULT_PLANS.map((p) => ({ id: randomUUID(), ...p })) });
    }
  }

  // ------------------------------------------------------------------ planos

  listPlans(options: { onlyActive?: boolean } = {}) {
    return this.prisma.plan.findMany({
      where: options.onlyActive ? { active: true } : undefined,
      orderBy: [{ sortOrder: "asc" }, { monthlyPrice: "asc" }],
      select: planSelect,
    });
  }

  findPlan(id: string) {
    return this.prisma.plan.findUnique({ where: { id }, select: planSelect });
  }

  async savePlan(plan: Plan) {
    const { id, ...data } = plan;
    await this.prisma.plan.upsert({ where: { id }, create: plan, update: data });
  }

  async planCodeExists(code: string, exceptId?: string) {
    return (await this.prisma.plan.count({ where: { code, NOT: exceptId ? { id: exceptId } : undefined } })) > 0;
  }

  // ------------------------------------------------------------------ definições

  async getSettings(): Promise<BillingSettings> {
    const row = await this.prisma.billingSettings.findUnique({ where: { id: 1 } });
    if (!row) return DEFAULT_SETTINGS;
    const { id: _id, updatedAt: _u, ...settings } = row;
    return settings;
  }

  async saveSettings(settings: BillingSettings) {
    await this.prisma.billingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
  }

  // ------------------------------------------------------------------ contas bancárias

  listBankAccounts(options: { onlyActive?: boolean } = {}) {
    return this.prisma.bankAccount.findMany({
      where: options.onlyActive ? { active: true } : undefined,
      orderBy: [{ active: "desc" }, { bankName: "asc" }],
      select: bankSelect,
    });
  }

  findBankAccount(id: string) {
    return this.prisma.bankAccount.findUnique({ where: { id }, select: bankSelect });
  }

  async saveBankAccount(account: BankAccount) {
    const { id, ...data } = account;
    await this.prisma.bankAccount.upsert({ where: { id }, create: account, update: data });
  }

  async deleteBankAccount(id: string) {
    await this.prisma.bankAccount.delete({ where: { id } });
  }

  async ibanExists(iban: string, exceptId?: string) {
    return (await this.prisma.bankAccount.count({ where: { iban, NOT: exceptId ? { id: exceptId } : undefined } })) > 0;
  }
}

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
} as const;

const bankSelect = { id: true, bankName: true, holder: true, iban: true, swift: true, active: true } as const;
