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
import type { Request } from "express";
import { type AccessTokenService, IDENTITY_TOKENS, type StaffAccess } from "../../application/ports";
import { ResolveStaffAccess } from "../../application/use-cases/staff/ResolveStaffAccess";
import type { Permission } from "../../domain/access-control";

type StaffRequest = Request & { staff?: StaffAccess };

const PERMISSIONS_KEY = "platform:required-permissions";
const RECENT_MFA_KEY = "platform:recent-mfa";

/**
 * 1) valida o token Bearer;
 * 2) confirma que a SESSÃO do token continua ativa;
 * 3) resolve o acesso REAL do membro na BD (conta ativa + permissões atuais).
 * Terminar a sessão, desativar a conta ou mudar permissões tem efeito no pedido seguinte.
 */
@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY_TOKENS.AccessTokenService) private readonly tokens: AccessTokenService,
    private readonly resolveAccess: ResolveStaffAccess,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<StaffRequest>();
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    const verified = scheme === "Bearer" && token ? await this.tokens.verify(token) : null;
    const access = verified
      ? await this.resolveAccess.execute({ id: verified.principal.id, sessionId: verified.sessionId })
      : null;

    if (!access) {
      throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sessão expirada. Inicie sessão novamente." });
    }
    request.staff = access;
    return true;
  }
}

/** Verifica se o membro tem as permissões exigidas pela rota. */
@Injectable()
export class StaffPermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    const staff = context.switchToHttp().getRequest<StaffRequest>().staff;

    if (!staff || !required.every((p) => staff.permissions.includes(p))) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para esta ação." });
    }

    // Ações sensíveis: 2FA verificada há menos de 10 minutos nesta sessão.
    const needsRecentMfa = this.reflector.getAllAndOverride<boolean>(RECENT_MFA_KEY, [context.getHandler(), context.getClass()]);
    if (needsRecentMfa && !staff.mfaFresh) {
      throw new ForbiddenException({
        code: "MFA_STEP_UP_REQUIRED",
        message: "Confirme a sua identidade com o código da app de autenticação.",
      });
    }
    return true;
  }
}

/**
 * Protege uma rota (ou controller) para a equipa interna.
 *   @StaffAuth()                      → basta estar autenticado
 *   @StaffAuth("schools.manage")      → exige a permissão
 */
export const StaffAuth = (...permissions: Permission[]) =>
  applyDecorators(SetMetadata(PERMISSIONS_KEY, permissions), UseGuards(StaffAuthGuard, StaffPermissionsGuard));

/**
 * Ação sensível: exige 2FA recente (o frontend pede o código e repete o pedido).
 * Usar junto com @StaffAuth(...).
 */
export const RequireRecentMfa = () => SetMetadata(RECENT_MFA_KEY, true);

/** Injeta o membro autenticado no handler: `@CurrentStaff() staff: StaffAccess`. */
export const CurrentStaff = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<StaffRequest>().staff,
);
