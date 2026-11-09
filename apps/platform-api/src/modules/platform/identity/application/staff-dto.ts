import {
  type Permission,
  ROLE_LABELS,
  rolePermissions,
  type StaffRole,
  type StaffStatus,
  STATUS_LABELS,
} from "../domain/access-control";
import type { StaffMember } from "../domain/StaffMember";

/** DTOs de leitura — nunca expõem o hash da senha nem o agregado. */

export interface StaffSummary {
  id: string;
  fullName: string;
  initials: string;
  email: string | null;
  phone: string | null;
  role: StaffRole;
  roleLabel: string;
  status: StaffStatus;
  statusLabel: string;
  lastLoginAt: string | null;
  createdAt: string;
  /** Verificação em dois passos configurada. */
  mfaEnabled: boolean;
}

export interface StaffProfile extends StaffSummary {
  firstName: string;
  /** Permissões efetivas (vazias se a conta não estiver ativa). */
  permissions: Permission[];
  /** Vêm do papel — não se podem retirar individualmente. */
  rolePermissions: Permission[];
  /** Atribuídas individualmente por um admin. */
  extraPermissions: Permission[];
  lockedUntil: string | null;
}

function initialsOf(fullName: string) {
  const parts = fullName.split(" ");
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function toStaffSummary(member: StaffMember): StaffSummary {
  return {
    id: member.id,
    fullName: member.fullName.value,
    initials: initialsOf(member.fullName.value),
    email: member.email?.value ?? null,
    phone: member.phone?.value ?? null,
    role: member.role,
    roleLabel: ROLE_LABELS[member.role],
    status: member.status,
    statusLabel: STATUS_LABELS[member.status],
    lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
    createdAt: member.createdAt.toISOString(),
    mfaEnabled: member.mfaEnabled,
  };
}

export function toStaffProfile(member: StaffMember): StaffProfile {
  return {
    ...toStaffSummary(member),
    firstName: member.fullName.firstName,
    permissions: member.permissions,
    rolePermissions: rolePermissions(member.role),
    extraPermissions: member.extraPermissions,
    lockedUntil: member.lockedUntil?.toISOString() ?? null,
  };
}
