import { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";

export type BillingErrorCode =
  | "PLAN_NOT_FOUND"
  | "PLAN_INACTIVE"
  | "INVALID_PLAN"
  | "INVALID_CYCLE"
  | "INVALID_SETTINGS"
  | "INVALID_BANK_ACCOUNT"
  | "BANK_ACCOUNT_NOT_FOUND"
  | "DUPLICATE";

export type BillingError = DomainError<BillingErrorCode>;

export const billingError = (code: BillingErrorCode, message: string, meta?: Record<string, unknown>): BillingError =>
  new DomainError(code, message, meta);
