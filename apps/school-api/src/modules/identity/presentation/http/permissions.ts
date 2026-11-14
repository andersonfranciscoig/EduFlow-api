import { applyDecorators, type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PrismaClient } from ".prisma/tenant-client";
import type { TenantRequest } from "../../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../application/ports";
import { ALL_PERMISSIONS, isPermission, type Permission, SUPPORT_PERMISSIONS } from "../../domain/permissions";

const REQUIRED = "school:permissions";

type PermissionRequest = TenantRequest & { schoolUser?: SchoolAccess; permissions?: Permission[] };

/**
 * Permissões efetivas de quem pede: o responsável tem todas; o suporte EduFlow só
 * as de configuração; os restantes, as que estão gravadas na BD do colégio.
 */
export async function permissionsOf(db: PrismaClient, access: SchoolAccess): Promise<Permission[]> {
  if (access.support) return SUPPORT_PERMISSIONS;
  if (access.isOwner) return ALL_PERMISSIONS;
  const rows = await db.schoolUserPermission.findMany({ where: { userId: access.id }, select: { permission: true } });
  return rows.map((r) => r.permission).filter(isPermission);
}

/**
 * Corre DEPOIS do TenantGuard e do SchoolAuthGuard (que estão no controller).
 * Exige TODAS as permissões indicadas; as do RH exigem também "hr.access".
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED, [context.getHandler(), context.getClass()]) ?? [];
    if (!required.length) return true;
    const request = context.switchToHttp().getRequest<PermissionRequest>();
    const access = request.schoolUser;
    if (!access || !request.tenant) throw new ForbiddenException({ code: "FORBIDDEN", message: "Sem permissão." });
    const have = (request.permissions ??= await permissionsOf(request.tenant.db, access));
    const needed = required.some((p) => p.startsWith("hr.")) ? ["hr.access" as Permission, ...required] : required;
    if (!needed.every((p) => have.includes(p))) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para esta ação. Peça acesso ao responsável do colégio." });
    }
    return true;
  }
}

/** `@RequirePermission("hr.settings.manage")` — num controller que já tem TenantGuard + SchoolAuthGuard. */
export const RequirePermission = (...permissions: Permission[]) => applyDecorators(SetMetadata(REQUIRED, permissions), UseGuards(PermissionsGuard));

const TEACHER_OK = "school:teacher-ok";

/**
 * Áreas de gestão (pedagógico, finanças): um PROFESSOR não entra — só no que é dele
 * (rotas marcadas com `@TeacherMay()`, ex.: "o meu horário"). Direção, secretaria, o
 * responsável e o suporte não são afetados. Corre DEPOIS do SchoolAuthGuard.
 */
@Injectable()
export class NoTeachersGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const access = context.switchToHttp().getRequest<PermissionRequest>().schoolUser;
    if (!access || access.support || access.isOwner || access.role !== "PROFESSOR") return true;
    if (this.reflector.getAllAndOverride<boolean>(TEACHER_OK, [context.getHandler(), context.getClass()])) return true;
    throw new ForbiddenException({ code: "FORBIDDEN", message: "Esta área não é de professores." });
  }
}

/** Rota que um professor também pode usar (num controller com NoTeachersGuard). */
export const TeacherMay = () => SetMetadata(TEACHER_OK, true);
