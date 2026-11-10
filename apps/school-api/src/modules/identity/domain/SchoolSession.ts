/** Validade máxima de uma sessão (igual à do token). */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Ações sensíveis exigem 2FA verificada há menos de 10 minutos. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export interface SchoolSessionProps {
  id: string;
  userId: string;
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
 * Sessão de um utilizador do colégio. O token só é aceite enquanto a sessão
 * estiver ativa — terminar a sessão invalida o token de imediato.
 */
export class SchoolSession {
  private constructor(private props: SchoolSessionProps) {}

  /** Só se abre uma sessão DEPOIS da 2FA verificada. */
  static open(input: { id: string; userId: string; ip: string | null; userAgent: string | null; now: Date }) {
    return new SchoolSession({
      id: input.id,
      userId: input.userId,
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

  static restore(props: SchoolSessionProps) {
    return new SchoolSession({ ...props });
  }

  isActive(now: Date) {
    return this.props.revokedAt === null && this.props.expiresAt > now;
  }

  hasRecentMfa(now: Date) {
    return now.getTime() - this.props.mfaVerifiedAt.getTime() < STEP_UP_WINDOW_MS;
  }

  revoke(reason: string, now: Date) {
    if (this.props.revokedAt) return;
    this.props.revokedAt = now;
    this.props.revokedReason = reason;
  }

  get id() { return this.props.id; }
  get userId() { return this.props.userId; }
  get snapshot(): Readonly<SchoolSessionProps> { return this.props; }
}
