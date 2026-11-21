import { applyDecorators, type CanActivate, type ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PrismaClient } from ".prisma/tenant-client";
import type { TenantRequest } from "../../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../application/ports";
import { ALL_PERMISSIONS, accessOf, isPermission, type Permission, SUPPORT_PERMISSIONS } from "../../domain/permissions";

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
 * Exige TODAS as permissões indicadas e a de acesso do grupo de cada uma.
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
    // cada permissão exige também a de acesso do seu grupo (hr.access, admissions.access…)
    const needed = [...new Set([...required.map(accessOf), ...required])];
    if (!needed.every((p) => have.includes(p))) {
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para esta ação. Peça acesso ao responsável do colégio." });
    }
    return true;
  }
}

/** `@RequirePermission("hr.settings.manage")` — num controller que já tem TenantGuard + SchoolAuthGuard. */
export const RequirePermission = (...permissions: Permission[]) => applyDecorators(SetMetadata(REQUIRED, permissions), UseGuards(PermissionsGuard));

const TEACHER_OK = "school:teacher-ok";
const HR_OK = "school:hr-ok";

/**
 * Áreas de gestão (pedagógico, secretaria, finanças): os papéis restritos não entram.
 *  - PROFESSOR: só no que é dele (rotas `@TeacherMay()`, ex.: "o meu horário").
 *  - RH: só no que é dos Recursos Humanos (rotas `@HrMay()`, ex.: as faltas dos professores) e no
 *    que é pessoal (`@TeacherMay()`: a caixa de notificações…). As áreas do RH (`v1/hr/*`) não usam
 *    este guard: lá decidem as permissões.
 * Direção, secretaria, o responsável e o suporte não são afetados. Corre DEPOIS do SchoolAuthGuard.
 */
@Injectable()
export class NoTeachersGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const access = context.switchToHttp().getRequest<PermissionRequest>().schoolUser;
    if (!access || access.support || access.isOwner) return true;
    const marked = (key: string) => !!this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]);
    if (access.role === "PROFESSOR") {
      if (marked(TEACHER_OK)) return true;
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Esta área não é de professores." });
    }
    if (access.role === "RH") {
      if (marked(HR_OK) || marked(TEACHER_OK)) return true;
      throw new ForbiddenException({ code: "FORBIDDEN", message: "Esta área não é dos Recursos Humanos." });
    }
    return true;
  }
}

/** Rota que um professor também pode usar (num controller com NoTeachersGuard). */
export const TeacherMay = () => SetMetadata(TEACHER_OK, true);

/** Rota (ou controller) que o papel Recursos Humanos também pode usar — as permissões continuam a decidir. */
export const HrMay = () => SetMetadata(HR_OK, true);
