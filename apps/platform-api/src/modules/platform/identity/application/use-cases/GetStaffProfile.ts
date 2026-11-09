import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../../domain/errors";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { toStaffProfile, type StaffProfile } from "../staff-dto";

export type { StaffProfile };

/** Perfil do próprio membro autenticado (rota /me). */
export class GetStaffProfile {
  constructor(private readonly members: StaffMemberRepository) {}

  async execute(input: { id: string }): Promise<Result<StaffProfile, IdentityError>> {
    const member = await this.members.findById(input.id);
    if (!member || member.status !== "ACTIVE") {
      return fail(identityError("ACCOUNT_NOT_FOUND", "Sessão inválida."));
    }
    return ok(toStaffProfile(member));
  }
}
