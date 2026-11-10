import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { parseLoginIdentifier, PlainPassword } from "../../../../../../libs/kernel/src/domain/contact";
import {
  OTP_POLICY,
  type OtpBlock,
  otpBlockMessage,
  otpBlockMeta,
  otpIssueBlock,
  otpVerifyBlock,
} from "../../../../../../libs/kernel/src/domain/email-otp";
import { generateOtpCode, hashOtp } from "../../../../../../libs/kernel/src/infrastructure/otp";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { EMAIL_CODE_TTL_MS, EmailCode } from "../domain/EmailCode";
import { identityError, type IdentityError } from "../domain/errors";
import type { EmailCodePurpose, SchoolUser } from "../domain/SchoolUser";
import type { ChallengeService, CodeMailer, IdentitySettings, PasswordHasher, TenantScope } from "./ports";
import type { LoginStep, SchoolSecurity } from "./SchoolSecurity";

export type CodePurpose = "activation" | "password-reset";
const PURPOSE: Record<CodePurpose, EmailCodePurpose> = { activation: "ACTIVATION", "password-reset": "PASSWORD_RESET" };

/**
 * Ativação da conta e recuperação da senha — sempre com um código por email:
 *   1. send   → envia um código de 6 dígitos (só a quem o pode usar);
 *   2. verify → código certo → bilhete de 10 min;
 *   3. setPassword → define a senha e segue para a 2FA (nunca abre sessão sozinho).
 * Quem só tem acesso ao email NÃO entra: a 2FA continua a ser exigida.
 */
export class AccountRecovery {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly mailer: CodeMailer,
    private readonly hasher: PasswordHasher,
    private readonly security: SchoolSecurity,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings,
  ) {}

  /**
   * Resposta igual exista ou não a conta (destination = null). Só quem pode
   * receber o código vê para onde foi enviado (email mascarado).
   */
  async send(scope: TenantScope, input: { identifier: string; purpose: CodePurpose }): Promise<Result<{ destination: string | null }, IdentityError>> {
    const user = await this.eligibleUser(scope, input.identifier, input.purpose);
    if (!user) return ok({ destination: null });

    const now = this.clock.now();
    const purpose = PURPOSE[input.purpose];
    // limites POR CONTA (não dependem do IP): 1/min, 5 por dia, 10 erros por dia
    const block = otpIssueBlock(await scope.codes.stats(user.id, purpose, windowStart(now)), now);
    if (block) return fail(blockError(block));

    const code = generateOtpCode();
    await scope.codes.save(EmailCode.issue({ id: this.ids.next(), userId: user.id, purpose, codeHash: hashCode(user.id, purpose, code), now }));
    try {
      await this.mailer.sendCode({
        to: { email: user.email!.value, name: user.fullName.value },
        school: { name: scope.schoolName, slug: scope.slug },
        purpose,
        code,
        validMinutes: EMAIL_CODE_TTL_MS / 60_000,
      });
    } catch {
      return fail(identityError("EMAIL_NOT_SENT", "Não foi possível enviar o email agora. Tente novamente dentro de instantes."));
    }
    return ok({ destination: user.email!.masked });
  }

  async verify(scope: TenantScope, input: { identifier: string; purpose: CodePurpose; code: string }): Promise<Result<{ ticket: string }, IdentityError>> {
    const user = await this.eligibleUser(scope, input.identifier, input.purpose);
    const purpose = PURPOSE[input.purpose];
    const latest = user ? await scope.codes.latest(user.id, purpose) : null;
    if (!user || !latest) return fail(identityError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));

    const now = this.clock.now();
    const block = otpVerifyBlock(await scope.codes.stats(user.id, purpose, windowStart(now)), now);
    if (block) return fail(blockError(block));

    const checked = latest.check(hashCode(user.id, purpose, input.code.replace(/\D/g, "")), this.clock.now());
    await scope.codes.save(latest);
    if (!checked.ok) return checked;
    return ok({ ticket: await this.challenges.issue(user.id, scope.schoolId, input.purpose) });
  }

  /** Define a senha (ativação ou recuperação) e devolve o passo da 2FA. */
  async setPassword(scope: TenantScope, input: { ticket: string; password: string }): Promise<Result<LoginStep, IdentityError>> {
    const challenge = await this.challenges.verify(input.ticket, scope.schoolId, ["activation", "password-reset"]);
    const user = challenge ? await scope.users.findById(challenge.userId) : null;
    if (!challenge || !user) return fail(identityError("INVALID_CHALLENGE", "O pedido expirou. Peça um novo código."));

    const password = PlainPassword.create(input.password);
    if (!password.ok) return password;
    const hash = await this.hasher.hash(password.value.value);
    const now = this.clock.now();

    const changed = challenge.purpose === "activation" ? user.activate(hash, now) : user.resetPassword(hash, now);
    if (!changed.ok) return changed;
    await scope.users.save(user);
    // nova senha → todas as sessões antigas deixam de valer
    if (challenge.purpose === "password-reset") await scope.sessions.revokeAll(user.id, "Senha reposta", now);
    return ok(await this.security.afterPassword(scope, user));
  }

  private async eligibleUser(scope: TenantScope, raw: string, purpose: CodePurpose): Promise<SchoolUser | null> {
    const identifier = parseLoginIdentifier(raw, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return null;
    const user = await scope.users.findByIdentifier(identifier.value);
    return user?.canReceiveCode(PURPOSE[purpose]) ? user : null;
  }
}

/** Hash ligado à pessoa e à finalidade: o mesmo código não serve noutro contexto. */
const hashCode = (userId: string, purpose: EmailCodePurpose, code: string) => hashOtp(`${userId}:${purpose}`, code);

const windowStart = (now: Date) => new Date(now.getTime() - OTP_POLICY.WINDOW_MS);

const blockError = (block: OtpBlock) =>
  identityError(block.reason === "COOLDOWN" ? "EMAIL_CODE_COOLDOWN" : "EMAIL_CODE_LIMIT", otpBlockMessage(block), otpBlockMeta(block));
