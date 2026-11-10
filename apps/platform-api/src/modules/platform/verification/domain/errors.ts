import { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";

export type VerificationErrorCode =
  | "INVALID_EMAIL_CODE"
  | "EMAIL_CODE_EXPIRED"
  | "EMAIL_CODE_COOLDOWN"
  | "EMAIL_CODE_LIMIT"
  | "EMAIL_NOT_SENT"
  | "EMAIL_NOT_VERIFIED";

export type VerificationError = DomainError<VerificationErrorCode>;

export const verificationError = (code: VerificationErrorCode, message: string, meta?: Record<string, unknown>): VerificationError =>
  new DomainError(code, message, meta);
