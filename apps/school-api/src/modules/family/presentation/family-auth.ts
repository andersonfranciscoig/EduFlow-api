import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { TenantRequest } from "../../../tenancy/tenant-context";
import { FamilyAuth } from "../application/FamilyAuth";
import type { FamilyAccountRow } from "../application/ports";
import { PrismaFamilyRepository } from "../infrastructure/prisma-family";

export interface FamilyPrincipal {
  account: FamilyAccountRow;
  sessionId: string;
}

type FamilyRequest = TenantRequest & { family?: FamilyPrincipal };

const unauthenticated = () => new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sessão expirada. Entre novamente." });

/**
 * Corre DEPOIS do TenantGuard. Aceita só tokens da FAMÍLIA (audiência própria) emitidos para ESTE
 * colégio; a conta tem de estar ativa e a sessão válida (confirmadas na BD a cada pedido).
 * Um token da equipa não passa aqui, e um token da família não passa no SchoolAuthGuard.
 */
@Injectable()
export class FamilyAuthGuard implements CanActivate {
  constructor(private readonly auth: FamilyAuth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FamilyRequest>();
    const tenant = request.tenant;
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    if (!tenant || scheme !== "Bearer" || !token) throw unauthenticated();
    const resolved = await this.auth.resolve(new PrismaFamilyRepository(tenant.db), tenant.entry.schoolId, token);
    if (!resolved) throw unauthenticated();
    request.family = resolved;
    return true;
  }
}

export const CurrentFamily = createParamDecorator((_: unknown, context: ExecutionContext): FamilyPrincipal => {
  const family = context.switchToHttp().getRequest<FamilyRequest>().family;
  if (!family) throw unauthenticated();
  return family;
});
