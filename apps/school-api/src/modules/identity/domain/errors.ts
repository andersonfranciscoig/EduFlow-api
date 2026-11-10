import type { ContactErrorCode } from "../../../../../../libs/kernel/src/domain/contact";
import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";

export type IdentityErrorCode =
  | ContactErrorCode
  // login
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_SUSPENDED"
  | "ACTIVATION_REQUIRED"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_STATE"
  // códigos por email (ativação / recuperação)
  | "INVALID_EMAIL_CODE"
  | "EMAIL_CODE_EXPIRED"
  | "EMAIL_CODE_COOLDOWN"
  | "EMAIL_CODE_LIMIT"
  | "EMAIL_NOT_SENT"
  // 2FA e sessões
  | "INVALID_CHALLENGE"
  | "INVALID_MFA_CODE"
  | "MFA_NOT_ENABLED"
  | "MFA_ALREADY_ENABLED"
  | "SESSION_NOT_FOUND";

export type IdentityError = DomainError<IdentityErrorCode>;

export const identityError = (code: IdentityErrorCode, message: string, meta?: Record<string, unknown>): IdentityError =>
  new DomainError(code, message, meta);
