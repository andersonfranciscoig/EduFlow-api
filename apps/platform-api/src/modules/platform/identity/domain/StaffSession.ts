/** Validade máxima de uma sessão (igual à do token). */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Uma ação sensível exige 2FA verificada há menos de 10 minutos. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export interface StaffSessionProps {
  id: string;
  staffId: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  mfaVerifiedAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/**
 * Sessão de um membro da equipa. O token de acesso só é aceite enquanto a
 * sessão estiver ativa — terminar a sessão invalida o token de imediato.
 */
export class StaffSession {
  private constructor(private props: StaffSessionProps) {}

  /** Só se abre uma sessão DEPOIS da 2FA verificada. */
  static open(input: { id: string; staffId: string; ip: string | null; userAgent: string | null; now: Date }) {
    return new StaffSession({
      id: input.id,
      staffId: input.staffId,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: new Date(input.now.getTime() + SESSION_TTL_MS),
      mfaVerifiedAt: input.now,
      revokedAt: null,
      revokedReason: null,
    });
  }

  static restore(props: StaffSessionProps) {
    return new StaffSession({ ...props });
  }

  isActive(now: Date) {
    return this.props.revokedAt === null && this.props.expiresAt > now;
  }

  hasRecentMfa(now: Date) {
    return now.getTime() - this.props.mfaVerifiedAt.getTime() < STEP_UP_WINDOW_MS;
  }

  markMfaVerified(now: Date) {
    this.props.mfaVerifiedAt = now;
  }

  revoke(reason: string, now: Date) {
    if (this.props.revokedAt) return;
    this.props.revokedAt = now;
    this.props.revokedReason = reason;
  }

  get id() { return this.props.id; }
  get staffId() { return this.props.staffId; }
  get snapshot(): Readonly<StaffSessionProps> { return this.props; }
}

export interface StaffSessionRepository {
  findById(id: string): Promise<StaffSession | null>;
  listActive(staffId: string, now: Date): Promise<StaffSession[]>;
  save(session: StaffSession): Promise<void>;
  /** Atualiza "visto pela última vez" sem carregar o agregado (chamado com moderação). */
  touch(id: string, now: Date): Promise<void>;
  /** Revoga todas as sessões ativas de um membro (exceto, opcionalmente, uma). Devolve quantas. */
  revokeAll(staffId: string, reason: string, now: Date, exceptId?: string): Promise<number>;
}
