import { ROLE_LABELS, type SchoolRole } from "../domain/SchoolUser";
import type { TenantScope } from "./ports";

export interface SchoolUserProfile {
  id: string;
  fullName: string;
  firstName: string;
  initials: string;
  email: string | null;
  phone: string | null;
  role: SchoolRole;
  roleLabel: string;
  isOwner: boolean;
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
  lastLoginAt: string | null;
  school: { slug: string; name: string };
}

/** Perfil do utilizador autenticado (para o portal). */
export class GetProfile {
  async execute(scope: TenantScope, userId: string): Promise<SchoolUserProfile | null> {
    const user = await scope.users.findById(userId);
    if (!user) return null;
    const parts = user.fullName.value.split(" ");
    return {
      id: user.id,
      fullName: user.fullName.value,
      firstName: user.fullName.firstName,
      initials: `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts[parts.length - 1][0] : ""}`.toUpperCase(),
      email: user.email?.value ?? null,
      phone: user.phone?.value ?? null,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      isOwner: user.isOwner,
      mfaEnabled: user.mfaEnabled,
      recoveryCodesLeft: user.mfa.recoveryCodeHashes.length,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      school: { slug: scope.slug, name: scope.schoolName },
    };
  }
}
