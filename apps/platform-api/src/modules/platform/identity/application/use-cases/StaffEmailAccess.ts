import type { Clock } from "../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import type { EmailVerificationService } from "../../../verification/application/EmailVerificationService";
import type { VerificationError } from "../../../verification/domain/errors";
import { identityError, type IdentityError } from "../../domain/errors";
import type { StaffMember } from "../../domain/StaffMember";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import type { StaffSessionRepository } from "../../domain/StaffSession";
import { EmailAddress } from "../../domain/value-objects/EmailAddress";
import { parseLoginIdentifier } from "../../domain/value-objects/LoginIdentifier";
import { PlainPassword } from "../../domain/value-objects/Password";
import type { IdentitySettings, PasswordHasher } from "../ports";
import type { StaffInvitations } from "./StaffInvitations";
import type { LoginStep, StaffSecurity } from "./StaffSecurity";

type Err = IdentityError | VerificationError;

/**
 * Códigos por email da equipa:
 *  - criar conta: o email tem de ser confirmado ANTES de a conta existir;
 *  - repor a senha: código → nova senha → continua a pedir a 2FA no login
 *    (quem só controla o email não entra) e as sessões antigas terminam.
 */
export class StaffEmailAccess {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly sessions: StaffSessionRepository,
    private readonly verification: EmailVerificationService,
    private readonly hasher: PasswordHasher,
    private readonly security: StaffSecurity,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings,
    private readonly invitations: StaffInvitations,
  ) {}

  // ================================================================ criar conta

  async sendSignUpCode(rawEmail: string): Promise<Result<{ destination: string }, Err>> {
    const email = EmailAddress.create(rawEmail);
    if (!email.ok) return email;
    const identifier = parseLoginIdentifier(email.value.value, this.settings.defaultPhoneCountryCode);
    if (identifier.ok && (await this.members.findByIdentifier(identifier.value))) {
      return fail(identityError("ACCOUNT_ALREADY_EXISTS", "Já existe uma conta com este email. Inicie sessão."));
    }
    // o painel da equipa é só para quem foi convidado (exceto o primeiro membro)
    if ((await this.members.count()) > 0 && !(await this.invitations.forSignUp(email.value.value))) {
      return fail(identityError("STAFF_NOT_INVITED", "Apenas pessoas autorizadas têm acesso a este painel."));
    }
    return this.verification.send({ purpose: "STAFF_SIGN_UP", email: email.value.value });
  }

  async verifySignUpCode(rawEmail: string, code: string): Promise<Result<{ emailProof: string }, Err>> {
    const email = EmailAddress.create(rawEmail);
    if (!email.ok) return email;
    const verified = await this.verification.verify({ purpose: "STAFF_SIGN_UP", email: email.value.value, code });
    return verified.ok ? ok({ emailProof: verified.value.proof }) : verified;
  }

  // ================================================================ repor a senha

  /** Resposta igual exista ou não a conta (destination = null). */
  async requestPasswordReset(rawIdentifier: string): Promise<Result<{ destination: string | null }, Err>> {
    const member = await this.recoverable(rawIdentifier);
    if (!member) return ok({ destination: null });
    const sent = await this.verification.send({ purpose: "STAFF_PASSWORD_RESET", email: member.email!.value, name: member.fullName.value });
    return sent.ok ? ok({ destination: sent.value.destination }) : sent;
  }

  async verifyPasswordReset(rawIdentifier: string, code: string): Promise<Result<{ ticket: string }, Err>> {
    const member = await this.recoverable(rawIdentifier);
    if (!member) return fail(identityError("INVALID_CHALLENGE", "Este código já não é válido. Peça um novo."));
    const verified = await this.verification.verify({ purpose: "STAFF_PASSWORD_RESET", email: member.email!.value, code });
    return verified.ok ? ok({ ticket: verified.value.proof }) : verified;
  }

  /** Nova senha → segue SEMPRE para a 2FA (nunca abre sessão sozinho). */
  async resetPassword(input: { identifier: string; ticket: string; password: string }): Promise<Result<LoginStep & { firstName: string }, Err>> {
    const member = await this.recoverable(input.identifier);
    if (!member) return fail(identityError("INVALID_CHALLENGE", "O pedido expirou. Peça um novo código."));
    const password = PlainPassword.create(input.password);
    if (!password.ok) return password;

    const consumed = await this.verification.consume({ purpose: "STAFF_PASSWORD_RESET", email: member.email!.value, proof: input.ticket });
    if (!consumed.ok) return consumed;

    const now = this.clock.now();
    const changed = member.resetPassword(await this.hasher.hash(password.value.value), now);
    if (!changed.ok) return changed;
    const revoked = await this.sessions.revokeAll(member.id, "Senha reposta", now);
    member.recordSessionsRevoked(member.id, revoked, "Senha reposta", now);
    await this.members.save(member);

    const step = await this.security.afterPassword({ id: member.id, mfaEnabled: member.mfaEnabled });
    return ok({ ...step, firstName: member.fullName.firstName });
  }

  private async recoverable(raw: string): Promise<StaffMember | null> {
    const identifier = parseLoginIdentifier(raw, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return null;
    const member = await this.members.findByIdentifier(identifier.value);
    return member?.canRecoverPassword ? member : null;
  }
}
