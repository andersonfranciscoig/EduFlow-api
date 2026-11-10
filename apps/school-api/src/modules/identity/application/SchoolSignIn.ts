import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { type IdentifierKind, parseLoginIdentifier } from "../../../../../../libs/kernel/src/domain/contact";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../domain/errors";
import type { IdentitySettings, PasswordHasher, TenantScope } from "./ports";
import type { LoginStep, SchoolSecurity } from "./SchoolSecurity";

export interface IdentifyOutput {
  exists: boolean;
  kind: IdentifierKind;
  /** Email minúsculo / telefone E.164. */
  normalized: string;
  /** Primeiro nome, para cumprimentar no passo seguinte. */
  firstName: string | null;
  /** Conta criada mas por ativar (o responsável, na 1.ª vez). */
  activationRequired: boolean;
}

/**
 * Primeiro fator, em dois passos:
 *   1. identify — o email/telefone tem conta NESTE colégio?
 *   2. password — senha certa → bilhete para a 2FA (ainda sem acesso).
 */
export class SchoolSignIn {
  /** Hash fictício para igualar o tempo de resposta quando a conta não existe. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly hasher: PasswordHasher,
    private readonly security: SchoolSecurity,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings,
  ) {}

  async identify(scope: TenantScope, raw: string): Promise<Result<IdentifyOutput, IdentityError>> {
    const identifier = parseLoginIdentifier(raw, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return identifier;
    const user = await scope.users.findByIdentifier(identifier.value);
    const visible = user && user.status !== "SUSPENDED" ? user : null;
    return ok({
      exists: visible !== null,
      kind: identifier.value.kind,
      normalized: identifier.value.value,
      firstName: visible?.fullName.firstName ?? null,
      activationRequired: visible?.status === "INVITED",
    });
  }

  async password(scope: TenantScope, input: { identifier: string; password: string }): Promise<Result<LoginStep, IdentityError>> {
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
    const user = await scope.users.findByIdentifier(identifier.value);

    if (!user || !user.passwordHash) {
      this.dummyHash ??= this.hasher.hash("eduflow-timing-equalizer");
      await this.hasher.verify(input.password, await this.dummyHash);
      return user?.status === "INVITED" ? fail(identityError("ACTIVATION_REQUIRED", "Esta conta ainda não foi ativada.")) : invalid();
    }

    if (user.isLocked(now)) {
      const minutes = Math.ceil((user.lockedUntil!.getTime() - now.getTime()) / 60_000);
      return fail(identityError("ACCOUNT_LOCKED", `Demasiadas tentativas. Tente novamente dentro de ${minutes} minuto${minutes === 1 ? "" : "s"}.`, { minutes }));
    }

    if (!(await this.hasher.verify(input.password, user.passwordHash))) {
      user.recordFailedLogin(now);
      await scope.users.save(user);
      if (user.isLocked(now)) return fail(identityError("ACCOUNT_LOCKED", "Demasiadas tentativas. A conta foi bloqueada por 15 minutos."));
      return invalid(user.remainingAttempts);
    }

    // Só depois de a senha estar certa revelamos o estado da conta.
    const allowed = user.ensureCanSignIn();
    if (!allowed.ok) return allowed;
    return ok(await this.security.afterPassword(scope, user));
  }
}
