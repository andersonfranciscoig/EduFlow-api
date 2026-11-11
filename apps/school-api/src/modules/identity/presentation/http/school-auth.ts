import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { TenantRequest } from "../../../../tenancy/tenant-context";
import { type AccessTokenService, IDENTITY_TOKENS, type SchoolAccess, type SupportTokenService } from "../../application/ports";
import { SchoolSecurity } from "../../application/SchoolSecurity";
import { SupportAccess } from "../../application/SupportAccess";
import { TenantScopes } from "../../infrastructure/tenant-scopes";

type AuthedRequest = TenantRequest & { schoolUser?: SchoolAccess };

const unauthenticated = () => new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sessão expirada. Inicie sessão novamente." });

const NO_SUPPORT = "school:no-support";
const SUPPORT_WRITE_OK = "school:support-write-ok";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Rota que o suporte EduFlow NUNCA pode usar (ex.: decidir o próprio acesso, senhas, 2FA). */
export const NoSupport = () => SetMetadata(NO_SUPPORT, true);
/** Rota que não altera dados do colégio e que o suporte pode chamar mesmo em só leitura (ex.: sair). */
export const SupportMayCall = () => SetMetadata(SUPPORT_WRITE_OK, true);

/**
 * Corre DEPOIS do TenantGuard:
 *  1) valida o token Bearer (chave ES256 própria do school-api);
 *  2) o token tem de ter sido emitido para ESTE colégio (claim "tid") —
 *     um token do colégio A nunca entra no colégio B;
 *  3) a sessão e a conta são confirmadas na BD do colégio, a cada pedido.
 *
 * Sessões de SUPORTE EduFlow (token de audiência própria):
 *  - a sessão e a autorização do colégio são confirmadas a cada pedido;
 *  - só leitura: qualquer pedido que não seja GET é recusado (salvo @SupportMayCall);
 *  - rotas @NoSupport recusadas sempre, mesmo em modo de edição.
 */
@Injectable()
export class SchoolAuthGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY_TOKENS.AccessTokenService) private readonly tokens: AccessTokenService,
    @Inject(IDENTITY_TOKENS.SupportTokenService) private readonly supportTokens: SupportTokenService,
    private readonly security: SchoolSecurity,
    private readonly support: SupportAccess,
    private readonly scopes: TenantScopes,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const tenant = request.tenant;
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    if (!tenant || scheme !== "Bearer" || !token) throw unauthenticated();

    const verified = await this.tokens.verify(token);
    if (verified) {
      if (verified.schoolId !== tenant.entry.schoolId) throw unauthenticated();
      const access = await this.security.resolveAccess(this.scopes.for(tenant), { userId: verified.principal.id, sessionId: verified.sessionId });
      if (!access) throw unauthenticated();
      request.schoolUser = access;
      return true;
    }

    // ---------------------------------------------------------------- suporte EduFlow
    const support = await this.supportTokens.verify(token);
    if (!support || support.schoolId !== tenant.entry.schoolId) throw unauthenticated();
    const access = await this.support.resolve(this.scopes.for(tenant), support.sessionId);
    if (!access?.support) throw unauthenticated();

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(NO_SUPPORT, targets)) {
      throw new ForbiddenException({ code: "SUPPORT_FORBIDDEN", message: "Esta área não está disponível numa sessão de suporte." });
    }
    if (access.support.mode === "READ" && !SAFE_METHODS.has(request.method) && !this.reflector.getAllAndOverride<boolean>(SUPPORT_WRITE_OK, targets)) {
      throw new ForbiddenException({ code: "SUPPORT_READ_ONLY", message: "Sessão de suporte só de leitura: não é possível alterar dados." });
    }
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
