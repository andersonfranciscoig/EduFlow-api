import type { Clock } from "../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../../domain/errors";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { parseLoginIdentifier } from "../../domain/value-objects/LoginIdentifier";
import type { IdentitySettings, PasswordHasher, StaffPrincipal } from "../ports";

export class AuthenticateStaffMember {
  /** Hash fictício para igualar o tempo de resposta quando a conta não existe. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly members: StaffMemberRepository,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings,
  ) {}

  /**
   * Primeiro fator (senha). Não abre sessão nem regista o login — isso só
   * acontece depois da 2FA (ver StaffSecurity).
   */
  async execute(input: { identifier: string; password: string }): Promise<Result<StaffPrincipal & { mfaEnabled: boolean }, IdentityError>> {
    const invalid = (remaining?: number) =>
      fail(
        identityError(
          "INVALID_CREDENTIALS",
          remaining !== undefined && remaining <= 2
            ? `Senha incorreta. Restam ${remaining} tentativa${remaining === 1 ? "" : "s"}.`
            : "Senha incorreta. Tente novamente.",
          { remaining },
        ),
      );

    const identifier = parseLoginIdentifier(input.identifier, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return invalid();

    const now = this.clock.now();
    const member = await this.members.findByIdentifier(identifier.value);

    if (!member) {
      this.dummyHash ??= this.hasher.hash("eduflow-timing-equalizer");
      await this.hasher.verify(input.password, await this.dummyHash);
      return invalid();
    }

    if (member.isLocked(now)) {
      const minutes = Math.ceil((member.lockedUntil!.getTime() - now.getTime()) / 60_000);
      return fail(
        identityError(
          "ACCOUNT_LOCKED",
          `Demasiadas tentativas. Tente novamente dentro de ${minutes} minuto${minutes === 1 ? "" : "s"}.`,
          { minutes },
        ),
      );
    }

    const matches = await this.hasher.verify(input.password, member.passwordHash);
    if (!matches) {
      member.recordFailedLogin(now);
      await this.members.save(member);
      if (member.isLocked(now)) {
        return fail(
          identityError("ACCOUNT_LOCKED", "Demasiadas tentativas. A conta foi bloqueada por 15 minutos."),
        );
      }
      return invalid(member.remainingAttempts);
    }

    // Só depois de a senha estar certa revelamos o estado da conta.
    const allowed = member.ensureCanSignIn();
    if (!allowed.ok) return allowed;

    return ok({ id: member.id, fullName: member.fullName.value, role: member.role, mfaEnabled: member.mfaEnabled });
  }
}
