import { HttpStatus } from "@nestjs/common";
import { z } from "zod";
import type { BillingErrorCode } from "../../domain/errors";
import { CYCLE_KINDS } from "../../domain/pricing";

export const BILLING_HTTP: Partial<Record<BillingErrorCode, HttpStatus>> = {
  PLAN_NOT_FOUND: HttpStatus.NOT_FOUND,
  BANK_ACCOUNT_NOT_FOUND: HttpStatus.NOT_FOUND,
  PLAN_INACTIVE: HttpStatus.CONFLICT,
  DUPLICATE: HttpStatus.CONFLICT,
};

export const uuidSchema = z.uuid({ error: "Identificador inválido." });

export const cycleSchema = z
  .object({
    kind: z.enum(CYCLE_KINDS, { error: "Escolha a periodicidade." }),
    quantity: z.coerce.number().int().optional().meta({ description: "Só para CUSTOM" }),
    unit: z.enum(["MONTHS", "YEARS"]).optional().meta({ description: "Só para CUSTOM" }),
  })
  .meta({ title: "BillingCycle", example: { kind: "CUSTOM", quantity: 2, unit: "YEARS" } });

export const quoteSchema = z
  .object({ planId: uuidSchema, cycle: cycleSchema })
  .meta({ title: "QuoteRequest" });

export const settingsSchema = z
  .object({
    quarterlyDiscountPct: z.coerce.number().int(),
    annualDiscountPct: z.coerce.number().int(),
    referenceEntity: z.string().trim(),
    referenceProvider: z.string().trim().max(60),
    referenceValidityDays: z.coerce.number().int(),
    transferInstructions: z.string().max(500).nullable().optional().transform((v) => v ?? null),
  })
  .meta({ title: "BillingSettings" });

export const planSchema = z
  .object({
    code: z.string().max(20),
    name: z.string().max(60),
    description: z.string().max(240).default(""),
    monthlyPrice: z.coerce.number().int(),
    maxStudents: z.coerce.number().int().nullable().default(null),
    features: z.array(z.string().max(80)).max(12).default([]),
    active: z.boolean().default(true),
    sortOrder: z.coerce.number().int().default(0),
  })
  .meta({ title: "PlanInput" });

export const bankAccountSchema = z
  .object({
    bankName: z.string().max(60),
    holder: z.string().max(120),
    iban: z.string().max(40).meta({ example: "AO06 0040 0000 1234 5678 1017 2" }),
    swift: z.string().max(11).nullable().optional().transform((v) => v ?? null),
    active: z.boolean().default(true),
  })
  .meta({ title: "BankAccountInput" });

export type QuoteBody = z.infer<typeof quoteSchema>;
export type SettingsBody = z.infer<typeof settingsSchema>;
export type PlanBody = z.infer<typeof planSchema>;
export type BankAccountBody = z.infer<typeof bankAccountSchema>;
