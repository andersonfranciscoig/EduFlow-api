import { OTP_POLICY } from "../../../../../../../libs/kernel/src/domain/email-otp";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { verificationError, type VerificationError } from "./errors";

export type VerificationPurpose = "STAFF_SIGN_UP" | "STAFF_PASSWORD_RESET" | "SCHOOL_SIGN_UP" | "SCHOOL_PASSWORD_RESET" | "SCHOOL_EMAIL_CHANGE";

/** Depois de confirmar o código, há 30 min para concluir (criar a conta / definir a senha). */
export const PROOF_TTL_MS = 30 * 60 * 1000;

export interface EmailVerificationProps {
  id: string;
  purpose: VerificationPurpose;
  email: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  proofHash: string | null;
  proofExpiresAt: Date | null;
  proofUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Um código de 6 dígitos enviado para um email, com uma finalidade.
 * Código certo → "prova" de uso único (30 min) que o passo seguinte consome.
 */
export class EmailVerification {
  private constructor(private props: EmailVerificationProps) {}

  static issue(input: { id: string; purpose: VerificationPurpose; email: string; codeHash: string; now: Date }) {
    return new EmailVerification({
      id: input.id,
      purpose: input.purpose,
      email: input.email,
      codeHash: input.codeHash,
      attempts: 0,
      expiresAt: new Date(input.now.getTime() + OTP_POLICY.TTL_MS),
      verifiedAt: null,
      proofHash: null,
      proofExpiresAt: null,
      proofUsedAt: null,
      createdAt: input.now,
    });
  }

  static restore(props: EmailVerificationProps) {
    return new EmailVerification({ ...props });
  }

  /** Confere o código; erros contam. Certo → fica verificado e recebe a prova. */
  confirm(codeHash: string, proofHash: string, now: Date): Result<void, VerificationError> {
    const p = this.props;
    const usable = !p.verifiedAt && p.expiresAt > now && p.attempts < OTP_POLICY.MAX_ATTEMPTS_PER_CODE;
    if (!usable) return fail(verificationError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));

    if (codeHash !== p.codeHash) {
      p.attempts += 1;
      const remaining = OTP_POLICY.MAX_ATTEMPTS_PER_CODE - p.attempts;
      return remaining > 0
        ? fail(verificationError("INVALID_EMAIL_CODE", `Código incorreto. Restam ${remaining} tentativa${remaining === 1 ? "" : "s"}.`, { remaining }))
        : fail(verificationError("EMAIL_CODE_EXPIRED", "Demasiadas tentativas. Peça um novo código."));
    }
    p.verifiedAt = now;
    p.proofHash = proofHash;
    p.proofExpiresAt = new Date(now.getTime() + PROOF_TTL_MS);
    return ok(undefined);
  }

  get snapshot(): Readonly<EmailVerificationProps> { return this.props; }
}
