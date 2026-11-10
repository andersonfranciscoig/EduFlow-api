import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { TenantRequest } from "../../../../tenancy/tenant-context";
import { type AccessTokenService, IDENTITY_TOKENS, type SchoolAccess } from "../../application/ports";
import { SchoolSecurity } from "../../application/SchoolSecurity";
import { TenantScopes } from "../../infrastructure/tenant-scopes";

type AuthedRequest = TenantRequest & { schoolUser?: SchoolAccess };

const unauthenticated = () => new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sessão expirada. Inicie sessão novamente." });

/**
 * Corre DEPOIS do TenantGuard:
 *  1) valida o token Bearer (chave ES256 própria do school-api);
 *  2) o token tem de ter sido emitido para ESTE colégio (claim "tid") —
 *     um token do colégio A nunca entra no colégio B;
 *  3) a sessão e a conta são confirmadas na BD do colégio, a cada pedido.
 */
@Injectable()
export class SchoolAuthGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY_TOKENS.AccessTokenService) private readonly tokens: AccessTokenService,
    private readonly security: SchoolSecurity,
    private readonly scopes: TenantScopes,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const tenant = request.tenant;
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    const verified = tenant && scheme === "Bearer" && token ? await this.tokens.verify(token) : null;
    if (!tenant || !verified || verified.schoolId !== tenant.entry.schoolId) throw unauthenticated();

    const access = await this.security.resolveAccess(this.scopes.for(tenant), {
      userId: verified.principal.id,
      sessionId: verified.sessionId,
    });
    if (!access) throw unauthenticated();
    request.schoolUser = access;
    return true;
  }
}

/** Rota só para utilizadores autenticados deste colégio (usar num controller com TenantGuard). */
export const SchoolAuth = () => applyDecorators(UseGuards(SchoolAuthGuard), ApiBearerAuth());

/** `@CurrentUser() user: SchoolAccess` */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().schoolUser!,
);
