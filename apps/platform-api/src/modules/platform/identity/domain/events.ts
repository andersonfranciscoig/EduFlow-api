/**
 * Eventos de domínio do agregado StaffMember.
 * O agregado regista-os; a aplicação persiste-os como histórico de atividade.
 */
export const STAFF_ACTIVITY_TYPES = [
  "MEMBER_REGISTERED",
  "SIGNED_IN",
  "SIGN_IN_FAILED",
  "ACCOUNT_LOCKED",
  "MEMBER_ACTIVATED",
  "MEMBER_SUSPENDED",
  "ROLE_CHANGED",
  "PERMISSIONS_CHANGED",
  "MFA_ENABLED",
  "MFA_RECOVERY_USED",
  "MFA_RECOVERY_REGENERATED",
  "MFA_RESET",
  "SESSIONS_REVOKED",
  "PASSWORD_RESET",
] as const;

export type StaffActivityType = (typeof STAFF_ACTIVITY_TYPES)[number];

export interface StaffEvent {
  type: StaffActivityType;
  /** Membro afetado. */
  subjectId: string;
  /** Quem fez a ação (null = sistema). */
  actorId: string | null;
  details: Record<string, unknown> | null;
  occurredAt: Date;
}
