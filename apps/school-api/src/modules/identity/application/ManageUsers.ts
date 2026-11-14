import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { EmailAddress, FullName } from "../../../../../../libs/kernel/src/domain/contact";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { identityError } from "../domain/errors";
import { ALL_PERMISSIONS, normalizePermissions, PERMISSION_GROUPS, PERMISSIONS, type Permission } from "../domain/permissions";
import { ROLE_LABELS, SCHOOL_ROLES, type SchoolRole, type SchoolUserStatus } from "../domain/SchoolUser";
import type { SchoolAccess } from "./ports";

export interface UserAdminRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: SchoolRole;
  status: SchoolUserStatus;
  isOwner: boolean;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  permissions: string[];
}

/** Utilizadores do colégio, vistos pelo responsável — na BD do PRÓPRIO colégio. */
export interface UserAdminRepository {
  list(): Promise<UserAdminRow[]>;
  find(id: string): Promise<UserAdminRow | null>;
  /** Utilizador por ativar (INVITED) com as permissões, numa transação. */
  create(input: { id: string; fullName: string; email: string; role: SchoolRole; permissions: Permission[]; grantedById: string; now: Date }): Promise<{ ok: true; value: UserAdminRow } | { ok: false; reason: "email_taken" }>;
  /** Muda o papel e substitui as permissões (numa transação). */
  update(id: string, input: { role: SchoolRole; permissions: Permission[]; grantedById: string; now: Date }): Promise<UserAdminRow>;
  /** Suspender termina também as sessões abertas. */
  setStatus(id: string, status: SchoolUserStatus, now: Date): Promise<UserAdminRow>;
  /** Só um convite por ativar (sem sessões, sem senha). */
  deleteInvited(id: string): Promise<boolean>;
  record(type: string, subjectId: string, actorId: string, details: Record<string, unknown>, now: Date): Promise<void>;
}

export interface UserInviteMailer {
  sendInvite(input: { to: { email: string; name: string }; school: { slug: string; name: string }; invitedBy: string; roleLabel: string }): Promise<void>;
}

const STATUS_LABELS: Record<SchoolUserStatus, string> = { INVITED: "Por ativar", ACTIVE: "Ativo", SUSPENDED: "Suspenso" };

const dto = (u: UserAdminRow) => ({
  id: u.id,
  fullName: u.fullName,
  email: u.email,
  phone: u.phone,
  role: u.role,
  roleLabel: ROLE_LABELS[u.role],
  status: u.status,
  statusLabel: STATUS_LABELS[u.status],
  isOwner: u.isOwner,
  mfaEnabled: u.mfaEnabled,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
  // o responsável tem todas (sem linhas na BD)
  permissions: u.isOwner ? ALL_PERMISSIONS : u.permissions,
});

/**
 * Utilizadores do portal e as suas permissões. Só o RESPONSÁVEL do colégio gere
 * (nunca numa sessão de suporte). O convidado ativa a conta pelo fluxo normal:
 * código por email → senha → 2FA.
 */
export class ManageUsers {
  constructor(
    private readonly mailer: UserInviteMailer,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private guard(actor: SchoolAccess) {
    return actor.isOwner && !actor.support ? ok(undefined) : fail(identityError("FORBIDDEN", "Só o responsável do colégio pode gerir os utilizadores."));
  }

  catalog() {
    return {
      roles: SCHOOL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
      permissionGroups: PERMISSION_GROUPS.map((g) => ({ key: g.key, label: g.label, permissions: g.permissions.map((p) => ({ key: p, label: PERMISSIONS[p].label, hint: PERMISSIONS[p].hint })) })),
    };
  }

  async list(repo: UserAdminRepository, actor: SchoolAccess) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    return ok({ ...this.catalog(), users: (await repo.list()).map(dto) });
  }

  private checkRoleAndPermissions(role: string, permissions: string[]) {
    if (!SCHOOL_ROLES.includes(role as SchoolRole)) return fail(identityError("INVALID_INPUT", "Escolha um papel válido."));
    const p = normalizePermissions(permissions);
    if (!p.ok) return fail(identityError("INVALID_PERMISSION", p.error.message));
    return ok({ role: role as SchoolRole, permissions: p.value });
  }

  async invite(repo: UserAdminRepository, actor: SchoolAccess, school: { slug: string; name: string }, input: { fullName: string; email: string; role: string; permissions: string[] }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const name = FullName.create(input.fullName);
    if (!name.ok) return fail(identityError(name.error.code, name.error.message));
    const email = EmailAddress.create(input.email);
    if (!email.ok) return fail(identityError(email.error.code, email.error.message));
    const checked = this.checkRoleAndPermissions(input.role, input.permissions);
    if (!checked.ok) return checked;
    const now = this.clock.now();
    const created = await repo.create({ id: this.ids.next(), fullName: name.value.value, email: email.value.value, ...checked.value, grantedById: actor.id, now });
    if (!created.ok) return fail(identityError("EMAIL_TAKEN", "Já existe um utilizador com este email."));
    await repo.record("USER_INVITED", created.value.id, actor.id, { role: checked.value.role, permissions: checked.value.permissions }, now);
    const emailSent = await this.sendInvite(created.value, school, actor);
    return ok({ user: dto(created.value), emailSent });
  }

  /**
   * Conta de PROFESSOR para um funcionário (o RH dá o acesso a partir do cadastro; a permissão
   * hr.employees.edit confirma-se no controller do RH). Sem outras permissões: só o que é do professor.
   */
  async inviteTeacher(repo: UserAdminRepository, inviter: { id: string; fullName: string }, school: { slug: string; name: string }, input: { fullName: string; email: string }) {
    const name = FullName.create(input.fullName);
    if (!name.ok) return fail(identityError(name.error.code, name.error.message));
    const email = EmailAddress.create(input.email);
    if (!email.ok) return fail(identityError(email.error.code, email.error.message));
    const now = this.clock.now();
    const created = await repo.create({ id: this.ids.next(), fullName: name.value.value, email: email.value.value, role: "PROFESSOR", permissions: [], grantedById: inviter.id, now });
    if (!created.ok) return fail(identityError("EMAIL_TAKEN", "Já existe um utilizador com este email."));
    await repo.record("USER_INVITED", created.value.id, inviter.id, { role: "PROFESSOR", permissions: [], via: "hr" }, now);
    const emailSent = await this.sendInvite(created.value, school, { fullName: inviter.fullName } as SchoolAccess);
    return ok({ user: dto(created.value), emailSent });
  }

  /** O email não pode impedir o convite: se falhar, o responsável reenvia mais tarde. */
  private async sendInvite(u: UserAdminRow, school: { slug: string; name: string }, actor: SchoolAccess) {
    if (!u.email) return false;
    try {
      await this.mailer.sendInvite({ to: { email: u.email, name: u.fullName }, school, invitedBy: actor.fullName, roleLabel: ROLE_LABELS[u.role] });
      return true;
    } catch {
      return false;
    }
  }

  private async target(repo: UserAdminRepository, actor: SchoolAccess, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const user = await repo.find(id);
    if (!user) return fail(identityError("USER_NOT_FOUND", "Utilizador não encontrado."));
    if (user.isOwner || user.id === actor.id) return fail(identityError("FORBIDDEN", "O responsável do colégio não pode ser alterado aqui."));
    return ok(user);
  }

  async update(repo: UserAdminRepository, actor: SchoolAccess, id: string, input: { role: string; permissions: string[] }) {
    const user = await this.target(repo, actor, id);
    if (!user.ok) return user;
    const checked = this.checkRoleAndPermissions(input.role, input.permissions);
    if (!checked.ok) return checked;
    const now = this.clock.now();
    const updated = await repo.update(id, { ...checked.value, grantedById: actor.id, now });
    const added = checked.value.permissions.filter((p) => !user.value.permissions.includes(p));
    const removed = user.value.permissions.filter((p) => !checked.value.permissions.includes(p as Permission));
    if (added.length || removed.length || user.value.role !== checked.value.role) {
      await repo.record("USER_ACCESS_CHANGED", id, actor.id, { role: checked.value.role, added, removed }, now);
    }
    return ok(dto(updated));
  }

  async suspend(repo: UserAdminRepository, actor: SchoolAccess, id: string) {
    const user = await this.target(repo, actor, id);
    if (!user.ok) return user;
    if (user.value.status !== "ACTIVE") return fail(identityError("INVALID_STATE", "Só se suspende uma conta ativa."));
    const now = this.clock.now();
    const updated = await repo.setStatus(id, "SUSPENDED", now);
    await repo.record("USER_SUSPENDED", id, actor.id, {}, now);
    return ok(dto(updated));
  }

  async reactivate(repo: UserAdminRepository, actor: SchoolAccess, id: string) {
    const user = await this.target(repo, actor, id);
    if (!user.ok) return user;
    if (user.value.status !== "SUSPENDED") return fail(identityError("INVALID_STATE", "A conta não está suspensa."));
    const now = this.clock.now();
    const updated = await repo.setStatus(id, "ACTIVE", now);
    await repo.record("USER_REACTIVATED", id, actor.id, {}, now);
    return ok(dto(updated));
  }

  async resendInvite(repo: UserAdminRepository, actor: SchoolAccess, school: { slug: string; name: string }, id: string) {
    const user = await this.target(repo, actor, id);
    if (!user.ok) return user;
    if (user.value.status !== "INVITED") return fail(identityError("INVALID_STATE", "Esta conta já foi ativada."));
    const emailSent = await this.sendInvite(user.value, school, actor);
    if (!emailSent) return fail(identityError("EMAIL_NOT_SENT", "Não foi possível enviar o email agora. Tente de novo dentro de momentos."));
    return ok({ emailSent });
  }

  async cancelInvite(repo: UserAdminRepository, actor: SchoolAccess, id: string) {
    const user = await this.target(repo, actor, id);
    if (!user.ok) return user;
    if (user.value.status !== "INVITED") return fail(identityError("INVALID_STATE", "Só se cancela um convite por ativar. Suspenda a conta."));
    if (!(await repo.deleteInvited(id))) return fail(identityError("INVALID_STATE", "Esta conta já foi ativada."));
    await repo.record("USER_INVITE_CANCELLED", id, actor.id, { email: user.value.email }, this.clock.now());
    return ok({ deleted: true });
  }
}
