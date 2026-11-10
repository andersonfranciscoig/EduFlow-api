import { HttpException, HttpStatus } from "@nestjs/common";
import type { IdentityError, IdentityErrorCode } from "../../domain/errors";

/** Tradução erro de domínio → HTTP. O corpo é sempre { code, message, meta }. */
export const STATUS_BY_CODE: Record<IdentityErrorCode, HttpStatus> = {
  INVALID_IDENTIFIER: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_EMAIL: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_PHONE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_NAME: HttpStatus.UNPROCESSABLE_ENTITY,
  WEAK_PASSWORD: HttpStatus.UNPROCESSABLE_ENTITY,
  ACCOUNT_ALREADY_EXISTS: HttpStatus.CONFLICT,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  ACCOUNT_LOCKED: HttpStatus.LOCKED,
  ACCOUNT_PENDING_APPROVAL: HttpStatus.FORBIDDEN,
  ACCOUNT_SUSPENDED: HttpStatus.FORBIDDEN,
  ACCOUNT_NOT_FOUND: HttpStatus.UNAUTHORIZED,
  STAFF_NOT_INVITED: HttpStatus.FORBIDDEN,
  INVITATION_INVALID: HttpStatus.GONE,
  MEMBER_NOT_FOUND: HttpStatus.NOT_FOUND,
  CANNOT_MANAGE_SELF: HttpStatus.FORBIDDEN,
  ADMIN_REQUIRED: HttpStatus.FORBIDDEN,
  LAST_ADMIN: HttpStatus.CONFLICT,
  INVALID_STATE: HttpStatus.CONFLICT,
  INVALID_PERMISSION: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_CHALLENGE: HttpStatus.UNAUTHORIZED,
  INVALID_MFA_CODE: HttpStatus.UNAUTHORIZED,
  MFA_NOT_ENABLED: HttpStatus.CONFLICT,
  MFA_ALREADY_ENABLED: HttpStatus.CONFLICT,
  MFA_STEP_UP_REQUIRED: HttpStatus.FORBIDDEN,
  SESSION_NOT_FOUND: HttpStatus.NOT_FOUND,
};

export function toHttpException(error: IdentityError): HttpException {
  return new HttpException(
    { code: error.code, message: error.message, meta: error.meta ?? null },
    STATUS_BY_CODE[error.code],
  );
}
