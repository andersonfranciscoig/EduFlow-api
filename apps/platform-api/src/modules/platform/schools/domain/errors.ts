import { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";

export type SchoolErrorCode =
  | "INVALID_SCHOOL_DATA"
  | "INVALID_OWNER"
  | "EMAIL_TAKEN"
  | "NIF_TAKEN"
  | "INVALID_CREDENTIALS"
  | "SCHOOL_NOT_FOUND"
  | "INVALID_STATE"
  | "INVALID_PAYMENT_METHOD"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_EXPIRED"
  | "AMOUNT_MISMATCH"
  | "INVALID_PROOF"
  | "PROOF_NOT_FOUND";

export type SchoolError = DomainError<SchoolErrorCode>;

export const schoolError = (code: SchoolErrorCode, message: string, meta?: Record<string, unknown>): SchoolError =>
  new DomainError(code, message, meta);
