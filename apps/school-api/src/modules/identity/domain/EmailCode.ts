import { OTP_POLICY } from "../../../../../../libs/kernel/src/domain/email-otp";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "./errors";
import type { EmailCodePurpose } from "./SchoolUser";

export const EMAIL_CODE_TTL_MS = OTP_POLICY.TTL_MS;
export const EMAIL_CODE_MAX_ATTEMPTS = OTP_POLICY.MAX_ATTEMPTS_PER_CODE;
export const EMAIL_CODE_RESEND_MS = OTP_POLICY.RESEND_MS;

export interface EmailCodeProps {
  id: string;
  userId: string;
  purpose: EmailCodePurpose;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/**
 * Código de 6 dígitos enviado por email. Só vale o MAIS RECENTE de cada
 * finalidade; expira em 15 min, aceita 5 tentativas e só se usa uma vez.
 */
export class EmailCode {
  private constructor(private props: EmailCodeProps) {}

  static issue({ now, ...input }: { id: string; userId: string; purpose: EmailCodePurpose; codeHash: string; now: Date }) {
    return new EmailCode({
      ...input,
      attempts: 0,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      consumedAt: null,
      createdAt: now,
    });
  }

  static restore(props: EmailCodeProps) {
    return new EmailCode({ ...props });
  }

  /** Segundos que faltam até se poder pedir outro código (0 = já pode). */
  resendWaitSeconds(now: Date): number {
    return Math.max(0, Math.ceil((this.props.createdAt.getTime() + EMAIL_CODE_RESEND_MS - now.getTime()) / 1000));
  }

  /** Confere o código. Erros contam; ao acertar, o código fica gasto. */
  check(codeHash: string, now: Date): Result<void, IdentityError> {
    const usable = !this.props.consumedAt && this.props.expiresAt > now && this.props.attempts < EMAIL_CODE_MAX_ATTEMPTS;
    if (!usable) return fail(identityError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));

    if (codeHash !== this.props.codeHash) {
      this.props.attempts += 1;
      const remaining = EMAIL_CODE_MAX_ATTEMPTS - this.props.attempts;
      return remaining > 0
        ? fail(identityError("INVALID_EMAIL_CODE", `Código incorreto. Restam ${remaining} tentativa${remaining === 1 ? "" : "s"}.`, { remaining }))
        : fail(identityError("EMAIL_CODE_EXPIRED", "Demasiadas tentativas. Peça um novo código."));
    }
    this.props.consumedAt = now;
    return ok(undefined);
  }

  get snapshot(): Readonly<EmailCodeProps> { return this.props; }
}
