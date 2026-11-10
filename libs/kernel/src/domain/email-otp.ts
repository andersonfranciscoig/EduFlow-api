/**
 * Política dos códigos de 6 dígitos enviados por email (OTP) — partilhada por
 * todos os serviços que os usam (platform-api e school-api).
 *
 * Por código:  15 min · 5 tentativas · só vale o mais recente · uso único.
 * Por conta (janela de 24 h, independente do IP):
 *   - 1 código por minuto;
 *   - no máximo 5 códigos;
 *   - no máximo 10 tentativas erradas (somando todos os códigos).
 * Com 10⁶ combinações, 10 tentativas por dia dão ~0,001% de hipótese — e
 * impede-se encher a caixa de correio de alguém com códigos.
 */
export const OTP_POLICY = {
  TTL_MS: 15 * 60 * 1000,
  MAX_ATTEMPTS_PER_CODE: 5,
  RESEND_MS: 60 * 1000,
  WINDOW_MS: 24 * 60 * 60 * 1000,
  MAX_CODES_PER_WINDOW: 5,
  MAX_FAILURES_PER_WINDOW: 10,
} as const;

/** Histórico recente de códigos de UMA conta/finalidade (últimas 24 h). */
export interface OtpStats {
  /** Quando foi criado o código mais recente (null = nenhum). */
  lastCreatedAt: Date | null;
  /** Quando foi criado o mais antigo dentro da janela (para saber quando liberta). */
  oldestInWindowAt: Date | null;
  codesInWindow: number;
  /** Soma das tentativas erradas de todos os códigos da janela. */
  failuresInWindow: number;
}

export type OtpBlock =
  | { reason: "COOLDOWN"; seconds: number }
  | { reason: "DAILY_LIMIT" | "TOO_MANY_FAILURES"; retryAt: Date };

function windowRelease(stats: OtpStats, now: Date): Date {
  const start = stats.oldestInWindowAt ?? now;
  return new Date(start.getTime() + OTP_POLICY.WINDOW_MS);
}

/** Pode enviar-se um novo código agora? (null = sim) */
export function otpIssueBlock(stats: OtpStats, now: Date): OtpBlock | null {
  if (stats.failuresInWindow >= OTP_POLICY.MAX_FAILURES_PER_WINDOW) {
    return { reason: "TOO_MANY_FAILURES", retryAt: windowRelease(stats, now) };
  }
  if (stats.codesInWindow >= OTP_POLICY.MAX_CODES_PER_WINDOW) {
    return { reason: "DAILY_LIMIT", retryAt: windowRelease(stats, now) };
  }
  if (stats.lastCreatedAt) {
    const wait = Math.ceil((stats.lastCreatedAt.getTime() + OTP_POLICY.RESEND_MS - now.getTime()) / 1000);
    if (wait > 0) return { reason: "COOLDOWN", seconds: wait };
  }
  return null;
}

/** Pode tentar-se um código agora? (bloqueia depois de demasiadas tentativas erradas no dia) */
export function otpVerifyBlock(stats: OtpStats, now: Date): OtpBlock | null {
  return stats.failuresInWindow >= OTP_POLICY.MAX_FAILURES_PER_WINDOW
    ? { reason: "TOO_MANY_FAILURES", retryAt: windowRelease(stats, now) }
    : null;
}

/** Mensagem para o utilizador (pt). */
export function otpBlockMessage(block: OtpBlock): string {
  if (block.reason === "COOLDOWN") return `Aguarde ${block.seconds} s para pedir outro código.`;
  const hours = Math.max(1, Math.ceil((block.retryAt.getTime() - Date.now()) / 3_600_000));
  return block.reason === "DAILY_LIMIT"
    ? `Já pediu demasiados códigos hoje. Tente novamente dentro de ${hours} h.`
    : `Demasiadas tentativas erradas. Por segurança, tente novamente dentro de ${hours} h.`;
}

/** Metadados para a resposta HTTP (o frontend usa "seconds" na contagem decrescente). */
export function otpBlockMeta(block: OtpBlock): Record<string, unknown> {
  return block.reason === "COOLDOWN" ? { seconds: block.seconds } : { retryAt: block.retryAt.toISOString(), reason: block.reason };
}
