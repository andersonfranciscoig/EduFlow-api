import type { Clock, IdGenerator } from "../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../../domain/errors";
import type { StaffMember } from "../../domain/StaffMember";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { StaffSession, type StaffSessionRepository } from "../../domain/StaffSession";
import type {
  AccessTokenService,
  ChallengeService,
  ClientInfo,
  RecoveryCodes,
  SecretCipher,
  StaffPrincipal,
  TotpService,
} from "../ports";

export type LoginStep =
  | { status: "MFA_REQUIRED"; challengeToken: string }
  | { status: "MFA_SETUP_REQUIRED"; challengeToken: string };

export interface OpenedSession {
  staff: StaffPrincipal;
  accessToken: string;
  expiresIn: number;
}

export interface SessionView {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/**
 * Segurança da conta da equipa: 2FA obrigatória (TOTP + códigos de
 * recuperação), sessões revogáveis e confirmação 2FA para ações sensíveis.
 */
export class StaffSecurity {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly sessions: StaffSessionRepository,
    private readonly tokens: AccessTokenService,
    private readonly challenges: ChallengeService,
    private readonly cipher: SecretCipher,
    private readonly totp: TotpService,
    private readonly recovery: RecoveryCodes,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  // ================================================================ login (depois da senha)

  /** A senha estava certa: o passo seguinte é sempre a 2FA (verificar ou configurar). */
  async afterPassword(member: { id: string; mfaEnabled: boolean }): Promise<LoginStep> {
    return member.mfaEnabled
      ? { status: "MFA_REQUIRED", challengeToken: await this.challenges.issue(member.id, "mfa-verify") }
      : { status: "MFA_SETUP_REQUIRED", challengeToken: await this.challenges.issue(member.id, "mfa-setup") };
  }

  /** Conclui o login com um código da app ou um código de recuperação. */
  async verifyLogin(challengeToken: string, code: string, client: ClientInfo): Promise<Result<OpenedSession, IdentityError>> {
    const member = await this.loadFromChallenge(challengeToken, "mfa-verify");
    if (!member.ok) return member;
    const checked = await this.checkCode(member.value, code);
    if (!checked.ok) return checked;
    return ok(await this.openSession(member.value, client));
  }

  // ================================================================ configuração da 2FA

  async startEnrollment(challengeToken: string): Promise<Result<{ secret: string; otpauthUrl: string; account: string }, IdentityError>> {
    const member = await this.loadFromChallenge(challengeToken, "mfa-setup");
    if (!member.ok) return member;
    const secret = this.totp.generateSecret();
    const started = member.value.beginMfaEnrollment(this.cipher.encrypt(secret));
    if (!started.ok) return started;
    await this.members.save(member.value);
    const account = member.value.email?.value ?? member.value.phone?.value ?? member.value.fullName.value;
    return ok({ secret, otpauthUrl: this.totp.otpauthUrl(secret, account), account });
  }

  async confirmEnrollment(
    challengeToken: string,
    code: string,
    client: ClientInfo,
  ): Promise<Result<OpenedSession & { recoveryCodes: string[] }, IdentityError>> {
    const loaded = await this.loadFromChallenge(challengeToken, "mfa-setup");
    if (!loaded.ok) return loaded;
    const member = loaded.value;
    const pending = member.mfa.pendingSecretCiphertext;
    if (!pending) return fail(identityError("INVALID_STATE", "Comece novamente a configuração."));

    const now = this.clock.now();
    const step = this.totp.verify(this.cipher.decrypt(pending), code.trim(), now.getTime());
    if (step === null) return this.wrongCode(member, now);

    const recoveryCodes = this.recovery.generate();
    const enabled = member.completeMfaEnrollment(step, recoveryCodes.map((c) => this.recovery.hash(c)), now);
    if (!enabled.ok) return enabled;
    const session = await this.openSession(member, client);
    return ok({ ...session, recoveryCodes });
  }

  // ================================================================ ações sensíveis

  /** Confirma a identidade numa sessão já aberta (válido por 10 minutos). */
  async stepUp(staffId: string, sessionId: string, code: string): Promise<Result<void, IdentityError>> {
    const [member, session] = await Promise.all([this.members.findById(staffId), this.sessions.findById(sessionId)]);
    const now = this.clock.now();
    if (!member || !session || session.staffId !== staffId || !session.isActive(now)) {
      return fail(identityError("SESSION_NOT_FOUND", "Sessão inválida."));
    }
    const checked = await this.checkCode(member, code);
    if (!checked.ok) return checked;
    session.markMfaVerified(now);
    await this.sessions.save(session);
    return ok(undefined);
  }

  /** Novos códigos de recuperação (os anteriores deixam de valer). Exige 2FA recente. */
  async regenerateRecoveryCodes(staffId: string): Promise<Result<{ recoveryCodes: string[] }, IdentityError>> {
    const member = await this.members.findById(staffId);
    if (!member) return fail(identityError("ACCOUNT_NOT_FOUND", "Sessão inválida."));
    const codes = this.recovery.generate();
    const result = member.regenerateRecoveryCodes(codes.map((c) => this.recovery.hash(c)), this.clock.now());
    if (!result.ok) return result;
    await this.members.save(member);
    return ok({ recoveryCodes: codes });
  }

  async status(staffId: string) {
    const member = await this.members.findById(staffId);
    return {
      mfaEnabled: !!member?.mfaEnabled,
      mfaEnabledAt: member?.mfa.enabledAt?.toISOString() ?? null,
      recoveryCodesLeft: member?.mfa.recoveryCodeHashes.length ?? 0,
    };
  }

  // ================================================================ sessões

  async listSessions(staffId: string, currentSessionId?: string): Promise<SessionView[]> {
    const sessions = await this.sessions.listActive(staffId, this.clock.now());
    return sessions.map((s) => {
      const p = s.snapshot;
      return {
        id: p.id,
        current: p.id === currentSessionId,
        ip: p.ip,
        userAgent: p.userAgent,
        createdAt: p.createdAt.toISOString(),
        lastSeenAt: p.lastSeenAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
      };
    });
  }

  async revokeOwnSession(staffId: string, sessionId: string): Promise<Result<void, IdentityError>> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.staffId !== staffId) return fail(identityError("SESSION_NOT_FOUND", "Sessão não encontrada."));
    session.revoke("Terminada pelo próprio", this.clock.now());
    await this.sessions.save(session);
    return ok(undefined);
  }

  async revokeOtherSessions(staffId: string, currentSessionId: string) {
    return { revoked: await this.sessions.revokeAll(staffId, "Terminada pelo próprio (outras sessões)", this.clock.now(), currentSessionId) };
  }

  async signOut(sessionId: string) {
    const session = await this.sessions.findById(sessionId);
    if (session) {
      session.revoke("Saiu", this.clock.now());
      await this.sessions.save(session);
    }
  }

  /** Um admin termina todas as sessões de outro membro. */
  async revokeMemberSessions(actorId: string, memberId: string, reason = "Terminada por um administrador") {
    const member = await this.members.findById(memberId);
    if (!member) return fail(identityError("MEMBER_NOT_FOUND", "Membro não encontrado."));
    const now = this.clock.now();
    const count = await this.sessions.revokeAll(memberId, reason, now);
    member.recordSessionsRevoked(actorId, count, reason, now);
    await this.members.save(member);
    return ok({ revoked: count });
  }

  async memberSecurity(memberId: string) {
    const member = await this.members.findById(memberId);
    if (!member) return fail(identityError("MEMBER_NOT_FOUND", "Membro não encontrado."));
    return ok({
      mfaEnabled: member.mfaEnabled,
      mfaEnabledAt: member.mfa.enabledAt?.toISOString() ?? null,
      recoveryCodesLeft: member.mfa.recoveryCodeHashes.length,
      sessions: await this.listSessions(memberId),
    });
  }

  // ================================================================ internos

  private async loadFromChallenge(token: string, purpose: "mfa-verify" | "mfa-setup"): Promise<Result<StaffMember, IdentityError>> {
    const staffId = await this.challenges.verify(token, purpose);
    const member = staffId ? await this.members.findById(staffId) : null;
    if (!member || member.status !== "ACTIVE") {
      return fail(identityError("INVALID_CHALLENGE", "O pedido expirou. Volte a introduzir a senha."));
    }
    if (member.isLocked(this.clock.now())) {
      return fail(identityError("ACCOUNT_LOCKED", "Demasiadas tentativas. Tente novamente mais tarde."));
    }
    return ok(member);
  }

  /** Aceita um código TOTP (6 dígitos) ou de recuperação (xxxx-xxxx). Erros contam para o bloqueio. */
  private async checkCode(member: StaffMember, rawCode: string): Promise<Result<void, IdentityError>> {
    const now = this.clock.now();
    const code = rawCode.trim();
    if (!member.mfaEnabled || !member.mfa.secretCiphertext) {
      return fail(identityError("MFA_NOT_ENABLED", "A verificação em dois passos não está ativa."));
    }

    const result = /^\d{6}$/.test(code.replace(/\s/g, ""))
      ? (() => {
          const step = this.totp.verify(this.cipher.decrypt(member.mfa.secretCiphertext!), code.replace(/\s/g, ""), now.getTime());
          return step === null ? fail(identityError("INVALID_MFA_CODE", "Código incorreto.")) : member.acceptTotpStep(step);
        })()
      : member.consumeRecoveryCode(this.recovery.hash(code), now);

    if (!result.ok) return this.wrongCode(member, now, result.error);
    await this.members.save(member);
    return ok(undefined);
  }

  private async wrongCode(member: StaffMember, now: Date, error?: IdentityError): Promise<Result<never, IdentityError>> {
    member.recordFailedLogin(now);
    await this.members.save(member);
    if (member.isLocked(now)) {
      return fail(identityError("ACCOUNT_LOCKED", "Demasiadas tentativas. A conta foi bloqueada por 15 minutos."));
    }
    return fail(error ?? identityError("INVALID_MFA_CODE", "Código incorreto. Confira a hora do telemóvel e tente de novo."));
  }

  private async openSession(member: StaffMember, client: ClientInfo): Promise<OpenedSession> {
    const now = this.clock.now();
    member.recordSuccessfulLogin(now);
    const session = StaffSession.open({ id: this.ids.next(), staffId: member.id, ip: client.ip, userAgent: client.userAgent, now });
    await this.members.save(member);
    await this.sessions.save(session);
    const staff = { id: member.id, fullName: member.fullName.value, role: member.role };
    return { staff, ...(await this.tokens.issue(staff, session.id)) };
  }
}
