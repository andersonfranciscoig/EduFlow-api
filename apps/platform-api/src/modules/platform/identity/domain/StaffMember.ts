import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import {
  effectivePermissions,
  PERMISSIONS,
  ROLE_LABELS,
  type Permission,
  type StaffRole,
  type StaffStatus,
} from "./access-control";
import { identityError, type IdentityError } from "./errors";
import type { StaffActivityType, StaffEvent } from "./events";
import type { EmailAddress } from "./value-objects/EmailAddress";
import type { FullName } from "./value-objects/FullName";
import type { LoginIdentifier } from "./value-objects/LoginIdentifier";
import type { PhoneNumber } from "./value-objects/PhoneNumber";

export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface StaffMemberProps {
  id: string;
  fullName: FullName;
  email: EmailAddress | null;
  phone: PhoneNumber | null;
  passwordHash: string;
  role: StaffRole;
  status: StaffStatus;
  extraPermissions: Permission[];
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  mfa: MfaState;
}

/** Estado da 2FA (segredos sempre cifrados — o domínio nunca vê o segredo em claro). */
export interface MfaState {
  secretCiphertext: string | null;
  pendingSecretCiphertext: string | null;
  enabledAt: Date | null;
  lastUsedStep: number | null;
  recoveryCodeHashes: string[];
}

export const NO_MFA: MfaState = {
  secretCiphertext: null,
  pendingSecretCiphertext: null,
  enabledAt: null,
  lastUsedStep: null,
  recoveryCodeHashes: [],
};

/**
 * Contexto de uma ação de gestão: quem a faz e quantos admins ativos existem
 * (necessário para nunca deixar a plataforma sem administradores).
 */
export interface ManagementContext {
  actor: StaffMember;
  activeAdminCount: number;
  now: Date;
}

/**
 * Agregado raiz: membro da equipa interna da EduFlow.
 * Todas as regras sobre o ciclo de vida da conta, acesso e bloqueio vivem aqui.
 */
export class StaffMember {
  private events: StaffEvent[] = [];

  private constructor(private props: StaffMemberProps) {}

  /**
   * Regista um novo membro.
   * O primeiro membro da plataforma torna-se ADMIN ativo (bootstrap);
   * os seguintes entram como GESTOR e aguardam aprovação de um admin.
   */
  static register(input: {
    id: string;
    fullName: FullName;
    identifier: LoginIdentifier;
    passwordHash: string;
    isFirstMember: boolean;
    now: Date;
  }): StaffMember {
    const member = new StaffMember({
      id: input.id,
      fullName: input.fullName,
      email: input.identifier.kind === "email" ? input.identifier.email : null,
      phone: input.identifier.kind === "phone" ? input.identifier.phone : null,
      passwordHash: input.passwordHash,
      role: input.isFirstMember ? "ADMIN" : "GESTOR",
      status: input.isFirstMember ? "ACTIVE" : "PENDING_APPROVAL",
      extraPermissions: [],
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: input.now,
      mfa: { ...NO_MFA },
    });
    member.record("MEMBER_REGISTERED", input.id, input.now, { role: member.role, status: member.status });
    return member;
  }

  /** Reconstrói a partir da persistência (sem aplicar regras de criação). */
  static restore(props: StaffMemberProps): StaffMember {
    return new StaffMember({
      ...props,
      extraPermissions: [...props.extraPermissions],
      mfa: { ...props.mfa, recoveryCodeHashes: [...props.mfa.recoveryCodeHashes] },
    });
  }

  // ================================================================ autenticação

  isLocked(now: Date): boolean {
    return this.props.lockedUntil !== null && this.props.lockedUntil > now;
  }

  /** Verifica se a conta (já com a senha validada) pode iniciar sessão. */
  ensureCanSignIn(): Result<void, IdentityError> {
    switch (this.props.status) {
      case "PENDING_APPROVAL":
        return fail(
          identityError("ACCOUNT_PENDING_APPROVAL", "A sua conta foi criada e aguarda aprovação de um administrador."),
        );
      case "SUSPENDED":
        return fail(identityError("ACCOUNT_SUSPENDED", "Esta conta está desativada. Fale com um administrador."));
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

  // ================================================================ gestão (feita por outro membro)

  /** Aprova uma conta pendente ou reativa uma conta desativada. */
  activate(ctx: ManagementContext): Result<void, IdentityError> {
    const allowed = this.ensureManageableBy(ctx.actor);
    if (!allowed.ok) return allowed;
    if (this.props.status === "ACTIVE") {
      return fail(identityError("INVALID_STATE", "Esta conta já está ativa."));
    }
    const previous = this.props.status;
    this.props.status = "ACTIVE";
    this.props.failedLoginAttempts = 0;
    this.props.lockedUntil = null;
    this.record("MEMBER_ACTIVATED", ctx.actor.id, ctx.now, { previousStatus: previous });
    return ok(undefined);
  }

  /** Desativa a conta: deixa de conseguir entrar (o acesso cai no pedido seguinte). */
  suspend(ctx: ManagementContext): Result<void, IdentityError> {
    const allowed = this.ensureManageableBy(ctx.actor);
    if (!allowed.ok) return allowed;
    if (this.props.status === "SUSPENDED") {
      return fail(identityError("INVALID_STATE", "Esta conta já está desativada."));
    }
    if (this.isActiveAdmin && ctx.activeAdminCount <= 1) {
      return fail(identityError("LAST_ADMIN", "Não pode desativar o último administrador ativo."));
    }
    const previous = this.props.status;
    this.props.status = "SUSPENDED";
    this.record("MEMBER_SUSPENDED", ctx.actor.id, ctx.now, { previousStatus: previous });
    return ok(undefined);
  }

  /** Altera o papel. Só administradores podem fazê-lo. */
  changeRole(role: StaffRole, ctx: ManagementContext): Result<void, IdentityError> {
    const allowed = this.ensureManageableBy(ctx.actor);
    if (!allowed.ok) return allowed;
    if (ctx.actor.role !== "ADMIN") {
      return fail(identityError("ADMIN_REQUIRED", "Só um administrador pode alterar papéis."));
    }
    if (role === this.props.role) {
      return fail(identityError("INVALID_STATE", `Este membro já é ${ROLE_LABELS[role]}.`));
    }
    if (this.isActiveAdmin && role !== "ADMIN" && ctx.activeAdminCount <= 1) {
      return fail(identityError("LAST_ADMIN", "Tem de existir pelo menos um administrador ativo."));
    }
    const from = this.props.role;
    this.props.role = role;
    // ao passar a ADMIN as permissões extra deixam de fazer sentido (tem tudo)
    if (role === "ADMIN") this.props.extraPermissions = [];
    this.record("ROLE_CHANGED", ctx.actor.id, ctx.now, { from, to: role });
    return ok(undefined);
  }

  /** Define as permissões extra (além das do papel). */
  setExtraPermissions(permissions: string[], ctx: ManagementContext): Result<void, IdentityError> {
    const allowed = this.ensureManageableBy(ctx.actor);
    if (!allowed.ok) return allowed;
    if (this.props.role === "ADMIN") {
      return fail(identityError("INVALID_STATE", "Administradores já têm acesso total."));
    }
    const invalid = permissions.filter((p) => !(PERMISSIONS as string[]).includes(p));
    if (invalid.length > 0) {
      return fail(identityError("INVALID_PERMISSION", `Permissão desconhecida: ${invalid.join(", ")}.`, { invalid }));
    }
    // só se pode atribuir o que se tem
    const actorPermissions = ctx.actor.permissions;
    const beyondActor = permissions.filter((p) => !actorPermissions.includes(p as Permission));
    if (beyondActor.length > 0) {
      return fail(
        identityError("ADMIN_REQUIRED", "Não pode atribuir permissões que você próprio não tem.", { beyondActor }),
      );
    }

    const next = PERMISSIONS.filter((p) => permissions.includes(p));
    const added = next.filter((p) => !this.props.extraPermissions.includes(p));
    const removed = this.props.extraPermissions.filter((p) => !next.includes(p));
    if (added.length === 0 && removed.length === 0) return ok(undefined);

    this.props.extraPermissions = next;
    this.record("PERMISSIONS_CHANGED", ctx.actor.id, ctx.now, { added, removed });
    return ok(undefined);
  }

  /** Regras comuns: não se gere a si próprio; contas de admin só por admins. */
  private ensureManageableBy(actor: StaffMember): Result<void, IdentityError> {
    if (actor.id === this.id) {
      return fail(identityError("CANNOT_MANAGE_SELF", "Não pode alterar a sua própria conta."));
    }
    if (this.props.role === "ADMIN" && actor.role !== "ADMIN") {
      return fail(identityError("ADMIN_REQUIRED", "Só um administrador pode alterar a conta de outro administrador."));
    }
    return ok(undefined);
  }

  // ================================================================ 2FA (obrigatória para toda a equipa)

  /** Guarda um novo segredo (ainda não ativo) para o membro configurar na app. */
  beginMfaEnrollment(secretCiphertext: string): Result<void, IdentityError> {
    if (this.props.mfa.enabledAt) {
      return fail(identityError("MFA_ALREADY_ENABLED", "A verificação em dois passos já está ativa."));
    }
    this.props.mfa.pendingSecretCiphertext = secretCiphertext;
    return ok(undefined);
  }

  /** Confirma a configuração com o primeiro código válido (step) e ativa a 2FA. */
  completeMfaEnrollment(step: number, recoveryCodeHashes: string[], now: Date): Result<void, IdentityError> {
    if (this.props.mfa.enabledAt) {
      return fail(identityError("MFA_ALREADY_ENABLED", "A verificação em dois passos já está ativa."));
    }
    if (!this.props.mfa.pendingSecretCiphertext) {
      return fail(identityError("INVALID_STATE", "Comece novamente a configuração."));
    }
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

  /** Usa (e gasta) um código de recuperação. */
  consumeRecoveryCode(hash: string, now: Date): Result<void, IdentityError> {
    const index = this.props.mfa.recoveryCodeHashes.indexOf(hash);
    if (!this.props.mfa.enabledAt || index === -1) {
      return fail(identityError("INVALID_MFA_CODE", "Código de recuperação inválido."));
    }
    this.props.mfa.recoveryCodeHashes.splice(index, 1);
    this.record("MFA_RECOVERY_USED", this.id, now, { remaining: this.props.mfa.recoveryCodeHashes.length });
    return ok(undefined);
  }

  regenerateRecoveryCodes(hashes: string[], now: Date): Result<void, IdentityError> {
    if (!this.props.mfa.enabledAt) return fail(identityError("MFA_NOT_ENABLED", "A verificação em dois passos não está ativa."));
    this.props.mfa.recoveryCodeHashes = hashes;
    this.record("MFA_RECOVERY_REGENERATED", this.id, now, null);
    return ok(undefined);
  }

  /** Um admin repõe a 2FA de quem perdeu o telemóvel — terá de configurar de novo. */
  resetMfa(ctx: ManagementContext): Result<void, IdentityError> {
    const allowed = this.ensureManageableBy(ctx.actor);
    if (!allowed.ok) return allowed;
    if (!this.props.mfa.enabledAt && !this.props.mfa.pendingSecretCiphertext) {
      return fail(identityError("MFA_NOT_ENABLED", "Este membro ainda não configurou a verificação em dois passos."));
    }
    this.props.mfa = { ...NO_MFA, recoveryCodeHashes: [] };
    this.record("MFA_RESET", ctx.actor.id, ctx.now, null);
    return ok(undefined);
  }

  /** Regista no histórico que sessões foram terminadas (por si ou por um admin). */
  recordSessionsRevoked(actorId: string, count: number, reason: string, now: Date) {
    if (count > 0) this.record("SESSIONS_REVOKED", actorId, now, { count, reason });
  }

  // ================================================================ eventos

  private record(type: StaffActivityType, actorId: string | null, now: Date, details: Record<string, unknown> | null) {
    this.events.push({ type, subjectId: this.id, actorId, details, occurredAt: now });
  }

  /** Devolve e limpa os eventos pendentes (para persistir após gravar). */
  pullEvents(): StaffEvent[] {
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
  get extraPermissions(): Permission[] { return [...this.props.extraPermissions]; }
  get failedLoginAttempts() { return this.props.failedLoginAttempts; }
  get remainingAttempts() { return MAX_FAILED_LOGINS - this.props.failedLoginAttempts; }
  get lockedUntil() { return this.props.lockedUntil; }
  get lastLoginAt() { return this.props.lastLoginAt; }
  get createdAt() { return this.props.createdAt; }
  get isActiveAdmin() { return this.props.role === "ADMIN" && this.props.status === "ACTIVE"; }
  get mfa(): Readonly<MfaState> { return this.props.mfa; }
  get mfaEnabled() { return this.props.mfa.enabledAt !== null; }

  /** Permissões efetivas (vazias se a conta não estiver ativa). */
  get permissions(): Permission[] {
    return this.props.status === "ACTIVE" ? effectivePermissions(this.props.role, this.props.extraPermissions) : [];
  }

  can(permission: Permission): boolean {
    return this.permissions.includes(permission);
  }
}
