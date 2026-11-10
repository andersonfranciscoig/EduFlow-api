import type { Clock, IdGenerator } from "../../../../../../../libs/kernel/src/application/ports";
import {
  OTP_POLICY,
  type OtpBlock,
  otpBlockMessage,
  otpBlockMeta,
  otpIssueBlock,
  otpVerifyBlock,
  type OtpStats,
} from "../../../../../../../libs/kernel/src/domain/email-otp";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { EmailVerification, type VerificationPurpose } from "../domain/EmailVerification";
import { verificationError, type VerificationError } from "../domain/errors";

export interface EmailVerificationRepository {
  latest(purpose: VerificationPurpose, email: string): Promise<EmailVerification | null>;
  stats(purpose: VerificationPurpose, email: string, since: Date): Promise<OtpStats>;
  save(verification: EmailVerification): Promise<void>;
  /** Gasta a prova de forma atómica (true = era válida e foi usada agora). */
  consumeProof(purpose: VerificationPurpose, email: string, proofHash: string, now: Date): Promise<boolean>;
}

export interface VerificationCodeMailer {
  send(input: { purpose: VerificationPurpose; to: { email: string; name: string | null }; code: string; validMinutes: number }): Promise<void>;
}

export interface OtpCrypto {
  generateCode(): string;
  hashCode(scope: string, code: string): string;
  generateProof(): { token: string; hash: string };
  hashProof(token: string): string;
}

/** "an•••@colegio.ao" */
export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
};

/**
 * Códigos por email da plataforma (criar conta, repor senha), para a equipa e
 * para os responsáveis dos colégios. Quem chama decide SE a pessoa pode receber
 * o código (conta livre/existente); este serviço trata do envio, limites e provas.
 */
export class EmailVerificationService {
  constructor(
    private readonly repo: EmailVerificationRepository,
    private readonly mailer: VerificationCodeMailer,
    private readonly crypto: OtpCrypto,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** @param email já normalizado (minúsculas) */
  async send(input: { purpose: VerificationPurpose; email: string; name?: string | null }): Promise<Result<{ destination: string }, VerificationError>> {
    const now = this.clock.now();
    const block = otpIssueBlock(await this.repo.stats(input.purpose, input.email, windowStart(now)), now);
    if (block) return fail(blockError(block));

    const code = this.crypto.generateCode();
    await this.repo.save(
      EmailVerification.issue({ id: this.ids.next(), purpose: input.purpose, email: input.email, codeHash: this.hash(input.purpose, input.email, code), now }),
    );
    try {
      await this.mailer.send({ purpose: input.purpose, to: { email: input.email, name: input.name ?? null }, code, validMinutes: OTP_POLICY.TTL_MS / 60_000 });
    } catch {
      return fail(verificationError("EMAIL_NOT_SENT", "Não foi possível enviar o email agora. Tente novamente dentro de instantes."));
    }
    return ok({ destination: maskEmail(input.email) });
  }

  /** Código certo → prova de uso único (30 min) para o passo seguinte. */
  async verify(input: { purpose: VerificationPurpose; email: string; code: string }): Promise<Result<{ proof: string }, VerificationError>> {
    const now = this.clock.now();
    const latest = await this.repo.latest(input.purpose, input.email);
    if (!latest) return fail(verificationError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));

    const block = otpVerifyBlock(await this.repo.stats(input.purpose, input.email, windowStart(now)), now);
    if (block) return fail(blockError(block));

    const proof = this.crypto.generateProof();
    const confirmed = latest.confirm(this.hash(input.purpose, input.email, input.code.replace(/\D/g, "")), proof.hash, now);
    await this.repo.save(latest);
    return confirmed.ok ? ok({ proof: proof.token }) : confirmed;
  }

  /** Gasta a prova (uma única vez). */
  async consume(input: { purpose: VerificationPurpose; email: string; proof: string }): Promise<Result<void, VerificationError>> {
    const used = input.proof ? await this.repo.consumeProof(input.purpose, input.email, this.crypto.hashProof(input.proof), this.clock.now()) : false;
    return used ? ok(undefined) : fail(verificationError("EMAIL_NOT_VERIFIED", "A confirmação do email expirou. Peça um novo código."));
  }

  private hash(purpose: VerificationPurpose, email: string, code: string) {
    return this.crypto.hashCode(`${purpose}:${email}`, code);
  }
}

const windowStart = (now: Date) => new Date(now.getTime() - OTP_POLICY.WINDOW_MS);

const blockError = (block: OtpBlock) =>
  verificationError(block.reason === "COOLDOWN" ? "EMAIL_CODE_COOLDOWN" : "EMAIL_CODE_LIMIT", otpBlockMessage(block), otpBlockMeta(block));
