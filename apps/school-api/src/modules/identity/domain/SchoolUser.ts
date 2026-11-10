import type { EmailAddress, FullName, PhoneNumber } from "../../../../../../libs/kernel/src/domain/contact";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "./errors";

export const SCHOOL_ROLES = ["DIRETOR", "SECRETARIA", "PROFESSOR"] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];
export type SchoolUserStatus = "INVITED" | "ACTIVE" | "SUSPENDED";
export type EmailCodePurpose = "ACTIVATION" | "PASSWORD_RESET";

export const ROLE_LABELS: Record<SchoolRole, string> = {
  DIRETOR: "Direção",
  SECRETARIA: "Secretaria",
  PROFESSOR: "Professor(a)",
};

export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

/** Estado da 2FA (segredos sempre cifrados — o domínio nunca vê o segredo em claro). */
export interface MfaState {
  secretCiphertext: string | null;
  pendingSecretCiphertext: string | null;
  enabledAt: Date | null;
  lastUsedStep: number | null;
  recoveryCodeHashes: string[];
}

export interface SchoolUserProps {
  id: string;
  fullName: FullName;
  email: EmailAddress | null;
  phone: PhoneNumber | null;
  passwordHash: string | null;
  role: SchoolRole;
  status: SchoolUserStatus;
  isOwner: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  mfa: MfaState;
}

export type SchoolActivityType =
  | "ACCOUNT_ACTIVATED"
  | "PASSWORD_RESET"
  | "SIGNED_IN"
  | "SIGN_IN_FAILED"
  | "ACCOUNT_LOCKED"
  | "MFA_ENABLED"
  | "MFA_RECOVERY_USED";

export interface SchoolActivityEvent {
  type: SchoolActivityType;
  subjectId: string;
  actorId: string | null;
  details: Record<string, unknown> | null;
  occurredAt: Date;
}

/**
 * Agregado raiz: pessoa do colégio com acesso ao portal.
 * Regras de ativação, bloqueio e 2FA vivem aqui (sem frameworks).
 */
export class SchoolUser {
  private events: SchoolActivityEvent[] = [];

  private constructor(private props: SchoolUserProps) {}

  static restore(props: SchoolUserProps): SchoolUser {
    return new SchoolUser({ ...props, mfa: { ...props.mfa, recoveryCodeHashes: [...props.mfa.recoveryCodeHashes] } });
  }

  // ================================================================ autenticação

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && this.props.lockedUntil > now;
  }

  /** Verifica se a conta (já com a senha validada) pode iniciar sessão. */
  ensureCanSignIn(): Result<void, IdentityError> {
    switch (this.props.status) {
      case "INVITED":
        return fail(identityError("ACTIVATION_REQUIRED", "Esta conta ainda não foi ativada. Ative-a com o código enviado para o seu email."));
      case "SUSPENDED":
        return fail(identityError("ACCOUNT_SUSPENDED", "Esta conta está desativada. Fale com a direção do colégio."));
      default:
        return ok(undefined);
    }
  }

  recordFailedLogin(now: Date): void {
    this.props.failedLoginAttempts += 1;
    if (this.props.failedLoginAttempts >= MAX_FAILED_LOGINS) {
      this.props.lockedUntil = new Date(now.getTime() + LOCK_DURATION_MS);
      this.props.failedLoginAttempts = 0;
      this.record("ACCOUNT_LOCKED", null, now, { minutes: LOCK_DURATION_MS / 60_000 });
    } else {
      this.record("SIGN_IN_FAILED", null, now, { remaining: this.remainingAttempts });
    }
  }

  recordSuccessfulLogin(now: Date): void {
    this.props.failedLoginAttempts = 0;
    this.props.lockedUntil = null;
    this.props.lastLoginAt = now;
    this.record("SIGNED_IN", this.id, now, null);
  }

  // ================================================================ códigos por email

  /** Só se envia código a quem o pode usar: ativação → conta por ativar; recuperação → conta ativa. */
  canReceiveCode(purpose: EmailCodePurpose): boolean {
    if (!this.props.email) return false;
    return purpose === "ACTIVATION" ? this.props.status === "INVITED" : this.props.status === "ACTIVE";
  }

  /** Ativação: define a primeira senha (o código por email já foi confirmado). */
  activate(passwordHash: string, now: Date): Result<void, IdentityError> {
    if (this.props.status !== "INVITED") return fail(identityError("INVALID_STATE", "Esta conta já está ativa. Entre com a sua senha."));
    this.props.passwordHash = passwordHash;
    this.props.status = "ACTIVE";
    this.props.failedLoginAttempts = 0;
    this.props.lockedUntil = null;
    this.record("ACCOUNT_ACTIVATED", this.id, now, null);
    return ok(undefined);
  }

  /** Recuperação: nova senha. A 2FA continua a ser pedida no login. */
  resetPassword(passwordHash: string, now: Date): Result<void, IdentityError> {
    if (this.props.status !== "ACTIVE") return fail(identityError("INVALID_STATE", "Não é possível repor a senha desta conta."));
    this.props.passwordHash = passwordHash;
    this.props.failedLoginAttempts = 0;
    this.props.lockedUntil = null;
    this.record("PASSWORD_RESET", this.id, now, null);
    return ok(undefined);
  }

  // ================================================================ 2FA (obrigatória)

  beginMfaEnrollment(secretCiphertext: string): Result<void, IdentityError> {
    if (this.props.mfa.enabledAt) return fail(identityError("MFA_ALREADY_ENABLED", "A verificação em dois passos já está ativa."));
    this.props.mfa.pendingSecretCiphertext = secretCiphertext;
    return ok(undefined);
  }

  completeMfaEnrollment(step: number, recoveryCodeHashes: string[], now: Date): Result<void, IdentityError> {
    if (this.props.mfa.enabledAt) return fail(identityError("MFA_ALREADY_ENABLED", "A verificação em dois passos já está ativa."));
    if (!this.props.mfa.pendingSecretCiphertext) return fail(identityError("INVALID_STATE", "Comece novamente a configuração."));
    this.props.mfa = {
      secretCiphertext: this.props.mfa.pendingSecretCiphertext,
      pendingSecretCiphertext: null,
      enabledAt: now,
      lastUsedStep: step,
      recoveryCodeHashes,
    };
    this.record("MFA_ENABLED", this.id, now, { recoveryCodes: recoveryCodeHashes.length });
    return ok(undefined);
  }

  /** Aceita um código TOTP; recusa reutilizar o mesmo (ou anterior) intervalo. */
  acceptTotpStep(step: number): Result<void, IdentityError> {
    if (!this.props.mfa.enabledAt) return fail(identityError("MFA_NOT_ENABLED", "A verificação em dois passos não está ativa."));
    if (this.props.mfa.lastUsedStep !== null && step <= this.props.mfa.lastUsedStep) {
      return fail(identityError("INVALID_MFA_CODE", "Este código já foi usado. Aguarde o próximo."));
    }
    this.props.mfa.lastUsedStep = step;
    return ok(undefined);
  }

  consumeRecoveryCode(hash: string, now: Date): Result<void, IdentityError> {
    const index = this.props.mfa.recoveryCodeHashes.indexOf(hash);
    if (!this.props.mfa.enabledAt || index === -1) return fail(identityError("INVALID_MFA_CODE", "Código de recuperação inválido."));
    this.props.mfa.recoveryCodeHashes.splice(index, 1);
    this.record("MFA_RECOVERY_USED", this.id, now, { remaining: this.props.mfa.recoveryCodeHashes.length });
    return ok(undefined);
  }

  // ================================================================ eventos

  private record(type: SchoolActivityType, actorId: string | null, now: Date, details: Record<string, unknown> | null) {
    this.events.push({ type, subjectId: this.id, actorId, details, occurredAt: now });
  }

  pullEvents(): SchoolActivityEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  // ================================================================ leitura

  get id() { return this.props.id; }
  get fullName() { return this.props.fullName; }
  get email() { return this.props.email; }
  get phone() { return this.props.phone; }
  get passwordHash() { return this.props.passwordHash; }
  get role() { return this.props.role; }
  get status() { return this.props.status; }
  get isOwner() { return this.props.isOwner; }
  get failedLoginAttempts() { return this.props.failedLoginAttempts; }
  get remainingAttempts() { return MAX_FAILED_LOGINS - this.props.failedLoginAttempts; }
  get lockedUntil() { return this.props.lockedUntil; }
  get lastLoginAt() { return this.props.lastLoginAt; }
  get createdAt() { return this.props.createdAt; }
  get mfa(): Readonly<MfaState> { return this.props.mfa; }
  get mfaEnabled() { return this.props.mfa.enabledAt !== null; }
}
