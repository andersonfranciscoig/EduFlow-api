import { HttpStatus } from "@nestjs/common";
import { z } from "zod";
import { cycleSchema } from "../../../billing/presentation/http/billing.schemas";
import type { SchoolErrorCode } from "../../domain/errors";
import { PROVINCES } from "../../domain/school-data";

export const SCHOOL_HTTP: Partial<Record<SchoolErrorCode, HttpStatus>> = {
  EMAIL_TAKEN: HttpStatus.CONFLICT,
  NIF_TAKEN: HttpStatus.CONFLICT,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  SCHOOL_NOT_FOUND: HttpStatus.NOT_FOUND,
  PROOF_NOT_FOUND: HttpStatus.NOT_FOUND,
  REFERENCE_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  REFERENCE_EXPIRED: HttpStatus.GONE,
};

const text = (message: string, max: number) => z.string({ error: message }).trim().min(1, message).max(max);

export const emailCheckSchema = z.object({ email: text("Indique o email.", 254) }).meta({ title: "EmailCheck" });
export const nifCheckSchema = z.object({ nif: text("Indique o NIF.", 20) }).meta({ title: "NifCheck" });

export const registerSchoolSchema = z
  .object({
    owner: z.object({
      name: text("Indique o nome do responsável.", 120),
      email: text("Indique o email.", 254).meta({ example: "direcao@colegioexemplo.ao" }),
      password: z.string({ error: "Indique a senha." }).max(128),
    }),
    school: z.object({
      name: text("Indique o nome do colégio.", 160).meta({ example: "Colégio Exemplo" }),
      nif: text("Indique o NIF.", 20).meta({ example: "5417123456" }),
      phone: text("Indique o telefone.", 30).meta({ example: "923 456 789" }),
      province: z.enum(PROVINCES, { error: "Escolha a província." }),
      municipality: text("Indique o município.", 80),
      address: text("Indique a morada.", 200),
    }),
    subscription: z.object({ planId: z.uuid({ error: "Escolha um plano." }), cycle: cycleSchema }),
  })
  .meta({ title: "RegisterSchool" });

export const signInSchema = z
  .object({ email: text("Indique o email.", 254), password: z.string().min(1, "Indique a senha.").max(128) })
  .meta({ title: "SchoolSignIn" });

export const proofSchema = z.object({
  transactionNumber: text("Indique o número da transação.", 60),
});

export const paymentMethodSchema = z
  .object({
    method: z.enum(["REFERENCE", "TRANSFER"], { error: "Escolha a forma de pagamento." }),
    bankAccountId: z.uuid().optional().meta({ description: "Obrigatório para TRANSFER" }),
  })
  .meta({ title: "PaymentMethodChoice" });

export const approveSchema = paymentMethodSchema
  .extend({
    databaseServerId: z
      .union([z.uuid(), z.literal("auto")])
      .nullable()
      .optional()
      .meta({ description: "Servidor de BD a reservar: \"auto\" (omissão), um id, ou null para decidir depois" }),
  })
  .meta({ title: "ApproveSchool" });

export const reasonSchema = z.object({ reason: text("Indique o motivo.", 500) }).meta({ title: "Reason" });

export const schoolStatusQuery = z.object({
  status: z.enum(["PENDING_REVIEW", "AWAITING_PAYMENT", "PAYMENT_UNDER_REVIEW", "ACTIVE", "REJECTED"]).optional(),
});

export type RegisterSchoolBody = z.infer<typeof registerSchoolSchema>;
export type PaymentMethodBody = z.infer<typeof paymentMethodSchema>;
export type ApproveBody = z.infer<typeof approveSchema>;
