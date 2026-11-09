import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { ClientInfo } from "../../application/ports";

/**
 * De onde vem o pedido. O frontend (Next.js, servidor) reencaminha o IP real
 * em X-Forwarded-For e o navegador em X-Client-User-Agent; só confiamos nesses
 * cabeçalhos porque "trust proxy" está limitado à rede local.
 */
export const Client = createParamDecorator((_: unknown, context: ExecutionContext): ClientInfo => {
  const request = context.switchToHttp().getRequest<Request>();
  const forwardedUa = request.header("x-client-user-agent");
  return {
    ip: request.ip ?? null,
    userAgent: (forwardedUa || request.header("user-agent") || "").slice(0, 300) || null,
  };
});
