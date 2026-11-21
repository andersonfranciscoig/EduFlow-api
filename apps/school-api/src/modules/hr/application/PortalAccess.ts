import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import type { ManageUsers, UserAdminRepository } from "../../identity/application/ManageUsers";
import { hrError, type SystemRole } from "../domain/form";
import type { HrActor } from "./Registration";
import type { School } from "./registration-ports";

export interface AccessEmployee {
  id: string;
  fullName: string;
  email: string | null;
  status: string;
  userId: string | null;
  /** o tipo de funcionário e o papel no sistema que ele define (sem tipo: PROFESSOR) */
  typeName: string | null;
  systemRole: SystemRole;
}

export interface LinkedUser {
  id: string;
  status: string;
  isOwner: boolean;
  role: string;
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
 * Acesso ao portal de um funcionário. O papel vem do TIPO de funcionário:
 *  - PROFESSOR: o RH dá-o a partir do cadastro (conta de professor);
 *  - RH: só o responsável do colégio (conta só dos Recursos Humanos, com as permissões do RH por omissão);
 *  - NONE (limpeza, segurança…): sem acesso ao sistema — recusa.
 * Convite por email (ativação normal: código → senha → 2FA), ou liga-se uma conta que já exista com o
 * mesmo email. Retirar: a conta fica suspensa (ou o convite cancelado); uma conta que não seja de
 * professor só o responsável a retira daqui.
 */
export class PortalAccess {
  constructor(
    private readonly users: ManageUsers,
    private readonly clock: Clock,
  ) {}

  async grant(repo: PortalAccessRepository, userRepo: UserAdminRepository, actor: HrActor & { id: string; name: string; isOwner: boolean }, school: School, employeeId: string) {
    const e = await repo.employee(employeeId);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    if (e.systemRole === "NONE")
      return fail(
        hrError(
          "INVALID_STATE",
          `${e.typeName ? `O tipo «${e.typeName}»` : "Este tipo de funcionário"} não tem acesso ao sistema. Só o responsável do colégio pode dar acesso, escolhendo o papel e o que pode usar (Definições → Utilizadores).`,
        ),
      );
    if (e.systemRole === "RH" && !actor.isOwner) return fail(hrError("FORBIDDEN", "Só o responsável do colégio dá acesso de Recursos Humanos."));
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

    const role = e.systemRole === "RH" ? "RH" : "PROFESSOR";
    const invited = await this.users.inviteTeacher(userRepo, { id: actor.id, fullName: actor.name }, school, { fullName: e.fullName, email: e.email, role });
    if (!invited.ok) return fail(hrError("INVALID_INPUT", invited.error.message));
    const linked = await repo.link(e.id, invited.value.user.id);
    if (!linked.ok) return fail(hrError("INVALID_STATE", "Esta conta já está ligada a outro funcionário."));
    await repo.addHistory({ employeeId: e.id, status: e.status, actorId: actor.id, actorName: actor.name, reason: `Acesso ao portal dado (${role === "RH" ? "Recursos Humanos" : "professor"}): convite enviado por email.`, now });
    return ok({ linkedExisting: false, emailSent: invited.value.emailSent, status: "INVITED" });
  }

  /** Retira o acesso: convite por ativar → cancelado; conta ativa → suspensa (o responsável do colégio nunca). */
  async revoke(repo: PortalAccessRepository, userRepo: UserAdminRepository, actor: HrActor & { id: string; name: string; isOwner: boolean }, employeeId: string) {
    const e = await repo.employee(employeeId);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    if (!e.userId) return fail(hrError("INVALID_STATE", "Este funcionário não tem acesso ao portal."));
    const u = await repo.user(e.userId);
    // o RH retira contas de professor; as outras (RH, direção, secretaria) só o responsável
    if (u && u.role !== "PROFESSOR" && !actor.isOwner) return fail(hrError("FORBIDDEN", "Só o responsável do colégio retira o acesso a esta conta (não é de professor)."));
    if (u && u.id === actor.id) return fail(hrError("INVALID_STATE", "Não pode retirar o seu próprio acesso."));
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
