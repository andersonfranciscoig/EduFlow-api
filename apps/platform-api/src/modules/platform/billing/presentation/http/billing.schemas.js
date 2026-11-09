"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bankAccountSchema = exports.planSchema = exports.settingsSchema = exports.quoteSchema = exports.cycleSchema = exports.uuidSchema = exports.BILLING_HTTP = void 0;
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const pricing_1 = require("../../domain/pricing");
exports.BILLING_HTTP = {
    PLAN_NOT_FOUND: common_1.HttpStatus.NOT_FOUND,
    BANK_ACCOUNT_NOT_FOUND: common_1.HttpStatus.NOT_FOUND,
    PLAN_INACTIVE: common_1.HttpStatus.CONFLICT,
    DUPLICATE: common_1.HttpStatus.CONFLICT,
};
exports.uuidSchema = zod_1.z.uuid({ error: "Identificador inválido." });
exports.cycleSchema = zod_1.z
    .object({
    kind: zod_1.z.enum(pricing_1.CYCLE_KINDS, { error: "Escolha a periodicidade." }),
    quantity: zod_1.z.coerce.number().int().optional().meta({ description: "Só para CUSTOM" }),
    unit: zod_1.z.enum(["MONTHS", "YEARS"]).optional().meta({ description: "Só para CUSTOM" }),
})
    .meta({ title: "BillingCycle", example: { kind: "CUSTOM", quantity: 2, unit: "YEARS" } });
exports.quoteSchema = zod_1.z
    .object({ planId: exports.uuidSchema, cycle: exports.cycleSchema })
    .meta({ title: "QuoteRequest" });
exports.settingsSchema = zod_1.z
    .object({
    quarterlyDiscountPct: zod_1.z.coerce.number().int(),
    annualDiscountPct: zod_1.z.coerce.number().int(),
    referenceEntity: zod_1.z.string().trim(),
    referenceProvider: zod_1.z.string().trim().max(60),
    referenceValidityDays: zod_1.z.coerce.number().int(),
    transferInstructions: zod_1.z.string().max(500).nullable().optional().transform((v) => v ?? null),
})
    .meta({ title: "BillingSettings" });
exports.planSchema = zod_1.z
    .object({
    code: zod_1.z.string().max(20),
    name: zod_1.z.string().max(60),
    description: zod_1.z.string().max(240).default(""),
    monthlyPrice: zod_1.z.coerce.number().int(),
    maxStudents: zod_1.z.coerce.number().int().nullable().default(null),
    features: zod_1.z.array(zod_1.z.string().max(80)).max(12).default([]),
    active: zod_1.z.boolean().default(true),
    sortOrder: zod_1.z.coerce.number().int().default(0),
})
    .meta({ title: "PlanInput" });
exports.bankAccountSchema = zod_1.z
    .object({
    bankName: zod_1.z.string().max(60),
    holder: zod_1.z.string().max(120),
    iban: zod_1.z.string().max(40).meta({ example: "AO06 0040 0000 1234 5678 1017 2" }),
    swift: zod_1.z.string().max(11).nullable().optional().transform((v) => v ?? null),
    active: zod_1.z.boolean().default(true),
})
    .meta({ title: "BankAccountInput" });
//# sourceMappingURL=billing.schemas.js.map