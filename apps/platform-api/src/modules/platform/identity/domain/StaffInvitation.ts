import type { StaffRole } from "./access-control";

/** Um convite vale 7 dias. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StaffInvitationProps {
  id: string;
  email: string;
  role: StaffRole;
  tokenHash: string;
  invitedById: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Convite para a equipa EduFlow. Só quem tem um convite pendente (ou o
 * primeiro membro da plataforma) pode criar conta no painel da equipa.
 */
export class StaffInvitation {
  private constructor(private props: StaffInvitationProps) {}

  static create({ now, ...input }: { id: string; email: string; role: StaffRole; tokenHash: string; invitedById: string; now: Date }) {
    return new StaffInvitation({
      ...input,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      acceptedAt: null,
      revokedAt: null,
      createdAt: now,
    });
  }

  static restore(props: StaffInvitationProps) {
    return new StaffInvitation({ ...props });
  }

  isPending(now: Date) {
    return !this.props.acceptedAt && !this.props.revokedAt && this.props.expiresAt > now;
  }

  accept(now: Date) {
    this.props.acceptedAt = now;
  }

  revoke(now: Date) {
    if (!this.props.acceptedAt) this.props.revokedAt = now;
  }

  get id() { return this.props.id; }
  get email() { return this.props.email; }
  get role() { return this.props.role; }
  get invitedById() { return this.props.invitedById; }
  get expiresAt() { return this.props.expiresAt; }
  get snapshot(): Readonly<StaffInvitationProps> { return this.props; }
}

export interface StaffInvitationRepository {
  findPendingByEmail(email: string, now: Date): Promise<StaffInvitation | null>;
  findByTokenHash(tokenHash: string): Promise<StaffInvitation | null>;
  findById(id: string): Promise<StaffInvitation | null>;
  listPending(now: Date): Promise<{ invitation: StaffInvitation; invitedByName: string | null }[]>;
  /** Pendentes para este email (para substituir por um convite novo). */
  pendingForEmail(email: string, now: Date): Promise<StaffInvitation[]>;
  save(invitation: StaffInvitation): Promise<void>;
}
