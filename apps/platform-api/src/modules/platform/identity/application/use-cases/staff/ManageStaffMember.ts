import type { Clock } from "../../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../../libs/kernel/src/domain/Result";
import type { StaffRole } from "../../../domain/access-control";
import { identityError, type IdentityError } from "../../../domain/errors";
import type { ManagementContext, StaffMember } from "../../../domain/StaffMember";
import type { StaffMemberRepository } from "../../../domain/StaffMemberRepository";
import { toStaffProfile, type StaffProfile } from "../../staff-dto";

/**
 * Base dos comandos de gestão da equipa:
 * carrega quem faz a ação e o alvo, aplica a regra de domínio, grava.
 * As regras em si (não se gerir a si próprio, último admin, etc.) vivem no
 * agregado StaffMember — aqui só se orquestra.
 */
abstract class StaffCommand<Input extends { actorId: string; memberId: string }> {
  constructor(
    protected readonly members: StaffMemberRepository,
    protected readonly clock: Clock,
  ) {}

  protected abstract apply(member: StaffMember, input: Input, ctx: ManagementContext): Result<void, IdentityError>;

  async execute(input: Input): Promise<Result<StaffProfile, IdentityError>> {
    const [actor, member] = await Promise.all([
      this.members.findById(input.actorId),
      this.members.findById(input.memberId),
    ]);
    if (!actor || actor.status !== "ACTIVE") {
      return fail(identityError("ACCOUNT_NOT_FOUND", "Sessão inválida."));
    }
    if (!member) return fail(identityError("MEMBER_NOT_FOUND", "Membro não encontrado."));

    const ctx: ManagementContext = {
      actor,
      activeAdminCount: await this.members.countActiveAdmins(),
      now: this.clock.now(),
    };

    const result = this.apply(member, input, ctx);
    if (!result.ok) return result;

    await this.members.save(member);
    return ok(toStaffProfile(member));
  }
}

type Target = { actorId: string; memberId: string };

/** Aprovar uma conta pendente ou reativar uma desativada. */
export class ActivateStaffMember extends StaffCommand<Target> {
  protected apply(member: StaffMember, _: Target, ctx: ManagementContext) {
    return member.activate(ctx);
  }
}

/** Desativar uma conta. */
export class SuspendStaffMember extends StaffCommand<Target> {
  protected apply(member: StaffMember, _: Target, ctx: ManagementContext) {
    return member.suspend(ctx);
  }
}

/** Alterar o papel (ADMIN ↔ GESTOR). */
export class ChangeStaffRole extends StaffCommand<Target & { role: StaffRole }> {
  protected apply(member: StaffMember, input: Target & { role: StaffRole }, ctx: ManagementContext) {
    return member.changeRole(input.role, ctx);
  }
}

/** Definir as permissões extra de um gestor. */
export class SetStaffPermissions extends StaffCommand<Target & { permissions: string[] }> {
  protected apply(member: StaffMember, input: Target & { permissions: string[] }, ctx: ManagementContext) {
    return member.setExtraPermissions(input.permissions, ctx);
  }
}

/** Repor a 2FA de quem perdeu o acesso à app (volta a configurar no próximo login). */
export class ResetStaffMfa extends StaffCommand<Target> {
  protected apply(member: StaffMember, _: Target, ctx: ManagementContext) {
    return member.resetMfa(ctx);
  }
}
