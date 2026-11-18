import type { Clock, IdGenerator, PasswordHasher } from "../../../../../../libs/kernel/src/application/ports";
import { EmailAddress, FullName, PhoneNumber, PlainPassword } from "../../../../../../libs/kernel/src/domain/contact";
import { OTP_POLICY, type OtpBlock, otpBlockMessage, otpBlockMeta, otpIssueBlock, otpVerifyBlock } from "../../../../../../libs/kernel/src/domain/email-otp";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { generateOtpCode, hashOtp } from "../../../../../../libs/kernel/src/infrastructure/otp";
import { type CodePurpose, type FamilyError, familyError, LOCK_MINUTES, MAX_FAILED_LOGINS, maskEmail, SESSION_HOURS } from "../domain/family";
import type { FamilyAccountRow, FamilyCodeRow, FamilyMailer, FamilyRepository, FamilyTokens, School } from "./ports";

const hashCode = (accountId: string, purpose: CodePurpose, code: string) => hashOtp(`family:${accountId}:${purpose}`, code);
const windowStart = (now: Date) => new Date(now.getTime() - OTP_POLICY.WINDOW_MS);
const blockError = (block: OtpBlock) => familyError(block.reason === "COOLDOWN" ? "EMAIL_CODE_COOLDOWN" : "EMAIL_CODE_LIMIT", otpBlockMessage(block), otpBlockMeta(block));
const invalidCredentials = () => familyError("INVALID_CREDENTIALS", "Email ou senha incorretos.");

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export type LoginStep = { step: "CODE"; challengeToken: string; destination: string } | { step: "ACTIVATE"; destination: string };

/**
 * Contas de família (encarregados e alunos maiores), à parte das contas da equipa:
 *   criar conta → código por email → ativa e entra;
 *   entrar      → email + senha → código por email (2.º fator, a cada entrada) → sessão;
 *   recuperar   → código por email → nova senha (todas as sessões terminam).
 * As respostas não revelam se um email já tem conta.
 */
export class FamilyAuth {
  private dummyHash: string | null = null;

  constructor(
    private readonly mailer: FamilyMailer,
    private readonly tokens: FamilyTokens,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly countryCode: string,
  ) {}

  // ---------------------------------------------------------------- códigos

  /**
   * Envia um código. `recentIsFine`: se um código desta finalidade acabou de ser enviado (menos de
   * 1 min), não é erro — esse código continua válido (ex.: criar conta e logo a seguir entrar).
   */
  private async sendCode(repo: FamilyRepository, school: School, account: FamilyAccountRow, purpose: CodePurpose, recentIsFine = false): Promise<Result<string, FamilyError>> {
    const now = this.clock.now();
    const block = otpIssueBlock(await repo.codeStats(account.id, purpose, windowStart(now)), now);
    if (block?.reason === "COOLDOWN" && recentIsFine) return ok(maskEmail(account.email));
    if (block) return fail(blockError(block));
    const code = generateOtpCode();
    await repo.saveCode({ id: this.ids.next(), accountId: account.id, purpose, codeHash: hashCode(account.id, purpose, code), attempts: 0, expiresAt: new Date(now.getTime() + OTP_POLICY.TTL_MS), consumedAt: null, createdAt: now });
    try {
      await this.mailer.sendCode({ to: { email: account.email, name: account.fullName }, school, purpose, code, validMinutes: OTP_POLICY.TTL_MS / 60_000 });
    } catch {
      return fail(familyError("EMAIL_NOT_SENT", "Não foi possível enviar o email agora. Tente novamente dentro de instantes."));
    }
    return ok(maskEmail(account.email));
  }

  /** Confere o código mais recente desta finalidade (5 tentativas, 15 min, uso único). */
  private async checkCode(repo: FamilyRepository, account: FamilyAccountRow, purpose: CodePurpose, raw: string): Promise<Result<void, FamilyError>> {
    const now = this.clock.now();
    const block = otpVerifyBlock(await repo.codeStats(account.id, purpose, windowStart(now)), now);
    if (block) return fail(blockError(block));
    const latest: FamilyCodeRow | null = await repo.latestCode(account.id, purpose);
    if (!latest || latest.consumedAt || latest.expiresAt <= now || latest.attempts >= OTP_POLICY.MAX_ATTEMPTS_PER_CODE) {
      return fail(familyError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));
    }
    if (hashCode(account.id, purpose, raw.replace(/\D/g, "")) !== latest.codeHash) {
      const attempts = latest.attempts + 1;
      await repo.saveCode({ ...latest, attempts });
      const remaining = OTP_POLICY.MAX_ATTEMPTS_PER_CODE - attempts;
      return fail(
        remaining > 0
          ? familyError("INVALID_EMAIL_CODE", `Código incorreto. Restam ${remaining} tentativa${remaining === 1 ? "" : "s"}.`, { remaining })
          : familyError("EMAIL_CODE_EXPIRED", "Demasiadas tentativas. Peça um novo código."),
      );
    }
    await repo.saveCode({ ...latest, consumedAt: now });
    return ok(undefined);
  }

  private async openSession(repo: FamilyRepository, school: School, account: FamilyAccountRow, client: ClientInfo) {
    const now = this.clock.now();
    const sessionId = this.ids.next();
    await repo.openSession({ id: sessionId, accountId: account.id, ip: client.ip, userAgent: client.userAgent?.slice(0, 300) ?? null, now, expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000) });
    await repo.update(account.id, { failedLogins: 0, lockedUntil: null, lastLoginAt: now, now });
    await repo.record("FAMILY_SIGNED_IN", account.id, account.id, { sessionId }, now);
    return { ...(await this.tokens.issueAccess({ accountId: account.id, sessionId, schoolId: school.id })), account: { id: account.id, fullName: account.fullName, email: account.email } };
  }

  // ---------------------------------------------------------------- criar conta

  async register(repo: FamilyRepository, school: School, input: { fullName: string; email: string; phone?: string | null; password: string }) {
    const name = FullName.create(input.fullName);
    if (!name.ok) return fail(familyError("INVALID_INPUT", name.error.message));
    const email = EmailAddress.create(input.email);
    if (!email.ok) return fail(familyError("INVALID_INPUT", email.error.message));
    let phone: string | null = null;
    if (input.phone?.trim()) {
      const p = PhoneNumber.create(input.phone, this.countryCode);
      if (!p.ok) return fail(familyError("INVALID_INPUT", p.error.message));
      phone = p.value.value;
    }
    const password = PlainPassword.create(input.password);
    if (!password.ok) return fail(familyError("INVALID_INPUT", password.error.message));

    const now = this.clock.now();
    const existing = await repo.byEmail(email.value.value);
    if (existing && existing.status !== "PENDING") {
      // já tem conta: avisa por email, mas a resposta é igual (não revela quem tem conta)
      try {
        await this.mailer.alreadyRegistered({ to: { email: existing.email, name: existing.fullName }, school });
      } catch {
        /* o aviso não é essencial */
      }
      return ok({ destination: maskEmail(existing.email) });
    }
    const passwordHash = await this.hasher.hash(password.value.value);
    let account: FamilyAccountRow;
    if (existing) {
      // ainda por ativar: os dados novos substituem os anteriores (só quem tem o email ativa)
      await repo.update(existing.id, { fullName: name.value.value, phone, passwordHash, now });
      account = { ...existing, fullName: name.value.value, phone, passwordHash };
    } else {
      const id = this.ids.next();
      await repo.create({ id, email: email.value.value, fullName: name.value.value, phone, passwordHash, now });
      account = (await repo.byId(id))!;
      await repo.record("FAMILY_ACCOUNT_CREATED", id, id, {}, now);
    }
    const sent = await this.sendCode(repo, school, account, "ACTIVATION", true);
    if (!sent.ok) return sent;
    return ok({ destination: sent.value });
  }

  /** Código de ativação certo → a conta fica ativa e a sessão abre. */
  async activate(repo: FamilyRepository, school: School, input: { email: string; code: string }, client: ClientInfo) {
    const account = await repo.byEmail(input.email.trim().toLowerCase());
    if (!account || account.status !== "PENDING") return fail(familyError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));
    const checked = await this.checkCode(repo, account, "ACTIVATION", input.code);
    if (!checked.ok) return checked;
    const now = this.clock.now();
    await repo.update(account.id, { status: "ACTIVE", activatedAt: now, now });
    await repo.record("FAMILY_ACCOUNT_ACTIVATED", account.id, account.id, {}, now);
    return ok(await this.openSession(repo, school, { ...account, status: "ACTIVE" }, client));
  }

  /** Reenviar o código de ativação (resposta igual exista ou não a conta). */
  async resendActivation(repo: FamilyRepository, school: School, input: { email: string }) {
    const account = await repo.byEmail(input.email.trim().toLowerCase());
    if (!account || account.status !== "PENDING") return ok({ destination: null as string | null });
    const sent = await this.sendCode(repo, school, account, "ACTIVATION");
    return sent.ok ? ok({ destination: sent.value as string | null }) : sent;
  }

  // ---------------------------------------------------------------- entrar

  async login(repo: FamilyRepository, school: School, input: { email: string; password: string }): Promise<Result<LoginStep, FamilyError>> {
    const account = await repo.byEmail(input.email.trim().toLowerCase());
    const now = this.clock.now();
    if (!account) {
      // o mesmo tempo de quem existe (não revela contas)
      this.dummyHash ??= await this.hasher.hash("eduflow-sem-conta");
      await this.hasher.verify(input.password, this.dummyHash);
      return fail(invalidCredentials());
    }
    if (account.lockedUntil && account.lockedUntil > now) {
      const minutes = Math.ceil((account.lockedUntil.getTime() - now.getTime()) / 60_000);
      return fail(familyError("ACCOUNT_LOCKED", `Demasiadas tentativas. Tente de novo dentro de ${minutes} min.`, { minutes }));
    }
    if (!(await this.hasher.verify(input.password, account.passwordHash))) {
      const failed = account.failedLogins + 1;
      await repo.update(account.id, failed >= MAX_FAILED_LOGINS ? { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000), now } : { failedLogins: failed, now });
      if (failed >= MAX_FAILED_LOGINS) await repo.record("FAMILY_ACCOUNT_LOCKED", account.id, null, {}, now);
      return fail(invalidCredentials());
    }
    if (account.status === "SUSPENDED") return fail(familyError("ACCOUNT_SUSPENDED", "Esta conta está suspensa. Fale com a secretaria do colégio."));
    if (account.status === "PENDING") {
      const sent = await this.sendCode(repo, school, account, "ACTIVATION", true);
      return sent.ok ? ok({ step: "ACTIVATE", destination: sent.value }) : sent;
    }
    const sent = await this.sendCode(repo, school, account, "LOGIN");
    if (!sent.ok) return sent;
    return ok({ step: "CODE", challengeToken: await this.tokens.issueChallenge({ accountId: account.id, schoolId: school.id }), destination: sent.value });
  }

  private async fromChallenge(repo: FamilyRepository, school: School, token: string) {
    const c = await this.tokens.verifyChallenge(token, school.id);
    const account = c ? await repo.byId(c.accountId) : null;
    return account && account.status === "ACTIVE" ? account : null;
  }

  async verifyLogin(repo: FamilyRepository, school: School, input: { challengeToken: string; code: string }, client: ClientInfo) {
    const account = await this.fromChallenge(repo, school, input.challengeToken);
    if (!account) return fail(familyError("INVALID_CHALLENGE", "O pedido expirou. Entre de novo."));
    const checked = await this.checkCode(repo, account, "LOGIN", input.code);
    if (!checked.ok) return checked;
    return ok(await this.openSession(repo, school, account, client));
  }

  async resendLogin(repo: FamilyRepository, school: School, input: { challengeToken: string }) {
    const account = await this.fromChallenge(repo, school, input.challengeToken);
    if (!account) return fail(familyError("INVALID_CHALLENGE", "O pedido expirou. Entre de novo."));
    const sent = await this.sendCode(repo, school, account, "LOGIN");
    return sent.ok ? ok({ destination: sent.value }) : sent;
  }

  // ---------------------------------------------------------------- recuperar a senha

  async recover(repo: FamilyRepository, school: School, input: { email: string }) {
    const account = await repo.byEmail(input.email.trim().toLowerCase());
    if (!account || account.status !== "ACTIVE") return ok({ destination: null as string | null });
    const sent = await this.sendCode(repo, school, account, "RECOVERY");
    return sent.ok ? ok({ destination: sent.value as string | null }) : sent;
  }

  async resetPassword(repo: FamilyRepository, input: { email: string; code: string; password: string }) {
    const account = await repo.byEmail(input.email.trim().toLowerCase());
    if (!account || account.status !== "ACTIVE") return fail(familyError("EMAIL_CODE_EXPIRED", "Este código já não é válido. Peça um novo."));
    const password = PlainPassword.create(input.password);
    if (!password.ok) return fail(familyError("INVALID_INPUT", password.error.message));
    const checked = await this.checkCode(repo, account, "RECOVERY", input.code);
    if (!checked.ok) return checked;
    const now = this.clock.now();
    await repo.update(account.id, { passwordHash: await this.hasher.hash(password.value.value), failedLogins: 0, lockedUntil: null, now });
    await repo.revokeAll(account.id, now);
    await repo.record("FAMILY_PASSWORD_RESET", account.id, account.id, {}, now);
    return ok({ reset: true });
  }

  // ---------------------------------------------------------------- sessão

  /** Token → conta ativa e sessão válida (renovada a cada pedido). */
  async resolve(repo: FamilyRepository, schoolId: string, token: string) {
    const v = await this.tokens.verifyAccess(token);
    if (!v || v.schoolId !== schoolId) return null;
    const now = this.clock.now();
    const account = await repo.byId(v.accountId);
    if (!account || account.status !== "ACTIVE") return null;
    if (!(await repo.touchSession(v.sessionId, account.id, now, new Date(now.getTime() + SESSION_HOURS * 3_600_000)))) return null;
    return { account, sessionId: v.sessionId };
  }

  async logout(repo: FamilyRepository, sessionId: string, accountId: string) {
    const now = this.clock.now();
    await repo.revokeSession(sessionId, now);
    await repo.record("FAMILY_SIGNED_OUT", accountId, accountId, { sessionId }, now);
    return { signedOut: true };
  }
}
