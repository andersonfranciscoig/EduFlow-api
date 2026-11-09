import { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";

export type IdentityErrorCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "INVALID_NAME"
  | "WEAK_PASSWORD"
  | "ACCOUNT_ALREADY_EXISTS"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_PENDING_APPROVAL"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_NOT_FOUND"
  // gestão da equipa
  | "MEMBER_NOT_FOUND"
  | "CANNOT_MANAGE_SELF"
  | "ADMIN_REQUIRED"
  | "LAST_ADMIN"
  | "INVALID_STATE"
  | "INVALID_PERMISSION"
  // 2FA e sessões
  | "INVALID_CHALLENGE"
  | "INVALID_MFA_CODE"
  | "MFA_NOT_ENABLED"
  | "MFA_ALREADY_ENABLED"
  | "MFA_STEP_UP_REQUIRED"
  | "SESSION_NOT_FOUND";

export type IdentityError = DomainError<IdentityErrorCode>;

export const identityError = (
  code: IdentityErrorCode,
  message: string,
  meta?: Record<string, unknown>,
): IdentityError => new DomainError(code, message, meta);
