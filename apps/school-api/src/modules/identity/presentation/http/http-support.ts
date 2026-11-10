import { createParamDecorator, type ExecutionContext, HttpStatus } from "@nestjs/common";
import type { Request } from "express";
import { unwrap } from "../../../../../../../libs/kernel/src/presentation/domain-http";
import type { ClientInfo } from "../../application/ports";
import type { IdentityError, IdentityErrorCode } from "../../domain/errors";

/** Tradução erro de domínio → HTTP. O corpo é sempre { code, message, meta }. */
const STATUS: Record<IdentityErrorCode, HttpStatus> = {
  INVALID_IDENTIFIER: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_EMAIL: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_PHONE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_NAME: HttpStatus.UNPROCESSABLE_ENTITY,
  WEAK_PASSWORD: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  ACCOUNT_LOCKED: HttpStatus.LOCKED,
  ACCOUNT_SUSPENDED: HttpStatus.FORBIDDEN,
  ACTIVATION_REQUIRED: HttpStatus.FORBIDDEN,
  ACCOUNT_NOT_FOUND: HttpStatus.UNAUTHORIZED,
  INVALID_STATE: HttpStatus.CONFLICT,
  INVALID_EMAIL_CODE: HttpStatus.UNAUTHORIZED,
  EMAIL_CODE_EXPIRED: HttpStatus.GONE,
  EMAIL_CODE_COOLDOWN: HttpStatus.TOO_MANY_REQUESTS,
  EMAIL_CODE_LIMIT: HttpStatus.TOO_MANY_REQUESTS,
  EMAIL_NOT_SENT: HttpStatus.BAD_GATEWAY,
  INVALID_CHALLENGE: HttpStatus.UNAUTHORIZED,
  INVALID_MFA_CODE: HttpStatus.UNAUTHORIZED,
  MFA_NOT_ENABLED: HttpStatus.CONFLICT,
  MFA_ALREADY_ENABLED: HttpStatus.CONFLICT,
  SESSION_NOT_FOUND: HttpStatus.NOT_FOUND,
};

/** Desembrulha o Result do caso de uso ou lança o erro HTTP correspondente. */
export const orThrow = <T>(result: { ok: true; value: T } | { ok: false; error: IdentityError }): T => unwrap(result, STATUS);

/**
 * De onde vem o pedido. O portal (Next.js, servidor) reencaminha o IP real em
 * X-Forwarded-For e o navegador em X-Client-User-Agent; só se confia nesses
 * cabeçalhos porque "trust proxy" está limitado à rede local.
 */
export const Client = createParamDecorator((_: unknown, context: ExecutionContext): ClientInfo => {
  const request = context.switchToHttp().getRequest<Request>();
  const forwardedUa = request.header("x-client-user-agent");
  return { ip: request.ip ?? null, userAgent: (forwardedUa || request.header("user-agent") || "").slice(0, 300) || null };
});
