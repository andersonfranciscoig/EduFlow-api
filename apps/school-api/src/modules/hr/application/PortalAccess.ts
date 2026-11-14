import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import type { ManageUsers, UserAdminRepository } from "../../identity/application/ManageUsers";
import { hrError } from "../domain/form";
import type { HrActor } from "./Registration";
import type { School } from "./registration-ports";

export interface AccessEmployee {
  id: string;
  fullName: string;
  email: string | null;
  status: string;
  userId: string | null;
}

export interface LinkedUser {
  id: string;
  status: string;
  isOwner: boolean;
  /** funcionário a que a conta já está ligada (outro que não este) */
  employeeId: string | null;
}

/** Ligação funcionário ↔ conta do portal (na BD do PRÓPRIO colégio). */
export interface PortalAccessRepository {
  employee(id: string): Promise<AccessEmployee | null>;
  userByEmail(email: string): Promise<LinkedUser | null>;
  user(id: string): Promise<LinkedUser | null>;
  /** Liga (falha "taken" se a conta já for de outro funcionário). */
  link(employeeId: string, userId: string): Promise<{ ok: true } | { ok: false; reason: "taken" }>;
  unlink(employeeId: string): Promise<void>;
  addHistory(input: { employeeId: string; status: string; actorId: string | null; actorName: string | null; reason: string; now: Date }): Promise<void>;
}

const ELIGIBLE = ["APPROVED", "ACTIVE", "SUSPENDED"];

/**
 * Acesso ao portal de um funcionário (ex.: o professor ver o seu horário). O RH dá-o a partir do
 * cadastro: cria uma conta de PROFESSOR (convite por email, ativação normal: código → senha → 2FA),
 * ou liga uma conta que já exista com o mesmo email. Retirar: a conta fica suspensa (ou o convite cancelado).
 */
export class PortalAccess {
  constructor(
    private readonly users: ManageUsers,
    private readonly clock: Clock,
  ) {}

  async grant(repo: PortalAccessRepository, userRepo: UserAdminRepository, actor: HrActor & { id: string; name: string }, school: School, employeeId: string) {
    const e = await repo.employee(employeeId);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    if (!ELIGIBLE.includes(e.status)) return fail(hrError("INVALID_STATE", "Só um funcionário aprovado ou ativo pode ter acesso ao portal."));
    if (e.userId) return fail(hrError("INVALID_STATE", "Este funcionário já tem acesso ao portal."));
    if (!e.email) return fail(hrError("INVALID_INPUT", "O funcionário precisa de um email no cadastro para receber o convite."));
    const now = this.clock.now();

    // já existe uma conta com este email (ex.: era utilizador antes): liga-se a ela
    const existing = await repo.userByEmail(e.email);
    if (existing) {
      if (existing.employeeId) return fail(hrError("INVALID_STATE", "A conta com este email já está ligada a outro funcionário."));
      const linked = await repo.link(e.id, existing.id);
      if (!linked.ok) return fail(hrError("INVALID_STATE", "A conta com este email já está ligada a outro funcionário."));
      // conta suspensa (ex.: o acesso tinha sido retirado): volta a ficar ativa
      let status = existing.status;
      if (status === "SUSPENDED" && !existing.isOwner) {
        await userRepo.setStatus(existing.id, "ACTIVE", now);
        await userRepo.record("USER_REACTIVATED", existing.id, actor.id, { via: "hr", employeeId: e.id }, now);
        status = "ACTIVE";
      }
      await repo.addHistory({ employeeId: e.id, status: e.status, actorId: actor.id, actorName: actor.name, reason: "Acesso ao portal: ligado à conta que já existia com este email.", now });
      return ok({ linkedExisting: true, emailSent: false, status });
    }

    const invited = await this.users.inviteTeacher(userRepo, { id: actor.id, fullName: actor.name }, school, { fullName: e.fullName, email: e.email });
    if (!invited.ok) return fail(hrError("INVALID_INPUT", invited.error.message));
    const linked = await repo.link(e.id, invited.value.user.id);
    if (!linked.ok) return fail(hrError("INVALID_STATE", "Esta conta já está ligada a outro funcionário."));
    await repo.addHistory({ employeeId: e.id, status: e.status, actorId: actor.id, actorName: actor.name, reason: "Acesso ao portal dado (professor): convite enviado por email.", now });
    return ok({ linkedExisting: false, emailSent: invited.value.emailSent, status: "INVITED" });
  }

  /** Retira o acesso: convite por ativar → cancelado; conta ativa → suspensa (o responsável do colégio nunca). */
  async revoke(repo: PortalAccessRepository, userRepo: UserAdminRepository, actor: HrActor & { id: string; name: string }, employeeId: string) {
    const e = await repo.employee(employeeId);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    if (!e.userId) return fail(hrError("INVALID_STATE", "Este funcionário não tem acesso ao portal."));
    const u = await repo.user(e.userId);
    const now = this.clock.now();
    await repo.unlink(e.id);
    if (u && !u.isOwner) {
      if (u.status === "INVITED") await userRepo.deleteInvited(u.id);
      else if (u.status === "ACTIVE") {
        await userRepo.setStatus(u.id, "SUSPENDED", now);
        await userRepo.record("USER_SUSPENDED", u.id, actor.id, { via: "hr", employeeId }, now);
      }
    }
    await repo.addHistory({ employeeId: e.id, status: e.status, actorId: actor.id, actorName: actor.name, reason: "Acesso ao portal retirado.", now });
    return ok({ revoked: true });
  }
}
