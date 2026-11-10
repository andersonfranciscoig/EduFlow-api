import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../domain/errors";
import { SchoolSession } from "../domain/SchoolSession";
import type { SchoolUser } from "../domain/SchoolUser";
import type {
  AccessTokenService,
  ChallengeService,
  ClientInfo,
  RecoveryCodes,
  SchoolAccess,
  SchoolPrincipal,
  SecretCipher,
  TenantScope,
  TotpService,
} from "./ports";

export type LoginStep =
  | { status: "MFA_REQUIRED"; challengeToken: string; firstName: string }
  | { status: "MFA_SETUP_REQUIRED"; challengeToken: string; firstName: string };

export interface OpenedSession {
  user: SchoolPrincipal;
  accessToken: string;
  expiresIn: number;
}

const TOUCH_EVERY_MS = 60_000;

/**
 * Segundo fator e sessões: 2FA obrigatória (TOTP + códigos de recuperação) e
 * sessões revogáveis. Só depois da 2FA existe um token de acesso.
 */
export class SchoolSecurity {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly challenges: ChallengeService,
    private readonly cipher: SecretCipher,
    private readonly totp: TotpService,
    private readonly recovery: RecoveryCodes,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** A senha estava certa: o passo seguinte é sempre a 2FA (verificar, ou configurar). */
  async afterPassword(scope: TenantScope, user: SchoolUser): Promise<LoginStep> {
    const firstName = user.fullName.firstName;
    return user.mfaEnabled
      ? { status: "MFA_REQUIRED", challengeToken: await this.challenges.issue(user.id, scope.schoolId, "mfa-verify"), firstName }
      : { status: "MFA_SETUP_REQUIRED", challengeToken: await this.challenges.issue(user.id, scope.schoolId, "mfa-setup"), firstName };
  }

  /** Conclui o login com um código da app ou de recuperação. */
  async verifyLogin(scope: TenantScope, challengeToken: string, code: string, client: ClientInfo): Promise<Result<OpenedSession, IdentityError>> {
    const user = await this.loadFromChallenge(scope, challengeToken, "mfa-verify");
    if (!user.ok) return user;
    const checked = await this.checkCode(scope, user.value, code);
    if (!checked.ok) return checked;
    return ok(await this.openSession(scope, user.value, client));
  }

  async startEnrollment(scope: TenantScope, challengeToken: string): Promise<Result<{ secret: string; otpauthUrl: string; account: string }, IdentityError>> {
    const user = await this.loadFromChallenge(scope, challengeToken, "mfa-setup");
    if (!user.ok) return user;
    const secret = this.totp.generateSecret();
    const started = user.value.beginMfaEnrollment(this.cipher.encrypt(secret));
    if (!started.ok) return started;
    await scope.users.save(user.value);
    const account = `${user.value.email?.value ?? user.value.phone?.value ?? user.value.fullName.value} (${scope.slug})`;
    return ok({ secret, otpauthUrl: this.totp.otpauthUrl(secret, account, "EduFlow"), account });
  }

  async confirmEnrollment(
    scope: TenantScope,
    challengeToken: string,
    code: string,
    client: ClientInfo,
  ): Promise<Result<OpenedSession & { recoveryCodes: string[] }, IdentityError>> {
    const loaded = await this.loadFromChallenge(scope, challengeToken, "mfa-setup");
    if (!loaded.ok) return loaded;
    const user = loaded.value;
    const pending = user.mfa.pendingSecretCiphertext;
    if (!pending) return fail(identityError("INVALID_STATE", "Comece novamente a configuração."));

    const now = this.clock.now();
    const step = this.totp.verify(this.cipher.decrypt(pending), code.replace(/\s/g, ""), now.getTime());
    if (step === null) return this.wrongCode(scope, user, now);

    const recoveryCodes = this.recovery.generate();
    const enabled = user.completeMfaEnrollment(step, recoveryCodes.map((c) => this.recovery.hash(c)), now);
    if (!enabled.ok) return enabled;
    return ok({ ...(await this.openSession(scope, user, client)), recoveryCodes });
  }

  async signOut(scope: TenantScope, sessionId: string) {
    const session = await scope.sessions.findById(sessionId);
    if (session) {
      session.revoke("Saiu", this.clock.now());
      await scope.sessions.save(session);
    }
  }

  /**
   * Acesso real de um pedido autenticado, lido na BD do colégio:
   * sessão ativa, conta ativa com 2FA, sessão do MESMO utilizador.
   */
  async resolveAccess(scope: TenantScope, input: { userId: string; sessionId: string }): Promise<SchoolAccess | null> {
    const now = this.clock.now();
    const [user, session] = await Promise.all([scope.users.findById(input.userId), scope.sessions.findById(input.sessionId)]);
    if (!user || user.status !== "ACTIVE" || !user.mfaEnabled) return null;
    if (!session || session.userId !== user.id || !session.isActive(now)) return null;
    if (now.getTime() - session.snapshot.lastSeenAt.getTime() > TOUCH_EVERY_MS) await scope.sessions.touch(session.id, now);
    return {
      id: user.id,
      fullName: user.fullName.value,
      role: user.role,
      isOwner: user.isOwner,
      schoolId: scope.schoolId,
      sessionId: session.id,
      mfaFresh: session.hasRecentMfa(now),
    };
  }

  // ================================================================ internos

  private async loadFromChallenge(scope: TenantScope, token: string, purpose: "mfa-verify" | "mfa-setup"): Promise<Result<SchoolUser, IdentityError>> {
    const challenge = await this.challenges.verify(token, scope.schoolId, [purpose]);
    const user = challenge ? await scope.users.findById(challenge.userId) : null;
    if (!user || user.status !== "ACTIVE") return fail(identityError("INVALID_CHALLENGE", "O pedido expirou. Volte a introduzir a senha."));
    if (user.isLocked(this.clock.now())) return fail(identityError("ACCOUNT_LOCKED", "Demasiadas tentativas. Tente novamente mais tarde."));
    return ok(user);
  }

  /** Código TOTP (6 dígitos) ou de recuperação (xxxx-xxxx). Erros contam para o bloqueio. */
  private async checkCode(scope: TenantScope, user: SchoolUser, rawCode: string): Promise<Result<void, IdentityError>> {
    const now = this.clock.now();
    const code = rawCode.trim().replace(/\s/g, "");
    if (!user.mfaEnabled || !user.mfa.secretCiphertext) return fail(identityError("MFA_NOT_ENABLED", "A verificação em dois passos não está ativa."));

    let result: Result<void, IdentityError>;
    if (/^\d{6}$/.test(code)) {
      const step = this.totp.verify(this.cipher.decrypt(user.mfa.secretCiphertext), code, now.getTime());
      result = step === null ? fail(identityError("INVALID_MFA_CODE", "Código incorreto.")) : user.acceptTotpStep(step);
    } else {
      result = user.consumeRecoveryCode(this.recovery.hash(code), now);
    }
    if (!result.ok) return this.wrongCode(scope, user, now, result.error);
    await scope.users.save(user);
    return ok(undefined);
  }

  private async wrongCode(scope: TenantScope, user: SchoolUser, now: Date, error?: IdentityError): Promise<Result<never, IdentityError>> {
    user.recordFailedLogin(now);
    await scope.users.save(user);
    if (user.isLocked(now)) return fail(identityError("ACCOUNT_LOCKED", "Demasiadas tentativas. A conta foi bloqueada por 15 minutos."));
    return fail(error ?? identityError("INVALID_MFA_CODE", "Código incorreto. Confira a hora do telemóvel e tente de novo."));
  }

  private async openSession(scope: TenantScope, user: SchoolUser, client: ClientInfo): Promise<OpenedSession> {
    const now = this.clock.now();
    user.recordSuccessfulLogin(now);
    const session = SchoolSession.open({ id: this.ids.next(), userId: user.id, ip: client.ip, userAgent: client.userAgent, now });
    await scope.users.save(user);
    await scope.sessions.save(session);
    const principal = { id: user.id, fullName: user.fullName.value, role: user.role };
    return { user: principal, ...(await this.tokens.issue(principal, session.id, scope.schoolId)) };
  }
}
