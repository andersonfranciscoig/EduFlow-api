import { fail, ok, type Result } from "../../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../../../domain/errors";
import type { StaffListFilter, StaffMemberRepository } from "../../../domain/StaffMemberRepository";
import type { StaffActivityEntry, StaffActivityQuery } from "../../ports";
import { toStaffProfile, toStaffSummary, type StaffProfile, type StaffSummary } from "../../staff-dto";

/** Lista da equipa, com contagens por estado. */
export class ListStaffMembers {
  constructor(private readonly members: StaffMemberRepository) {}

  async execute(filter: StaffListFilter = {}): Promise<{
    members: StaffSummary[];
    totals: { all: number; active: number; pending: number; suspended: number };
  }> {
    const all = await this.members.list();
    const filtered = all.filter(
      (m) => (!filter.status || m.status === filter.status) && (!filter.role || m.role === filter.role),
    );
    return {
      members: filtered.map(toStaffSummary),
      totals: {
        all: all.length,
        active: all.filter((m) => m.status === "ACTIVE").length,
        pending: all.filter((m) => m.status === "PENDING_APPROVAL").length,
        suspended: all.filter((m) => m.status === "SUSPENDED").length,
      },
    };
  }
}

/** Perfil completo de qualquer membro (qualquer estado). */
export class GetStaffMember {
  constructor(private readonly members: StaffMemberRepository) {}

  async execute(input: { id: string }): Promise<Result<StaffProfile, IdentityError>> {
    const member = await this.members.findById(input.id);
    if (!member) return fail(identityError("MEMBER_NOT_FOUND", "Membro não encontrado."));
    return ok(toStaffProfile(member));
  }
}

/** Histórico de atividade de um membro (o que fez e o que lhe fizeram). */
export class GetStaffActivity {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly activity: StaffActivityQuery,
  ) {}

  async execute(input: { id: string; limit?: number; before?: string }): Promise<Result<StaffActivityEntry[], IdentityError>> {
    if (!(await this.members.findById(input.id))) {
      return fail(identityError("MEMBER_NOT_FOUND", "Membro não encontrado."));
    }
    const before = input.before ? new Date(input.before) : undefined;
    return ok(
      await this.activity.forMember(input.id, {
        limit: Math.min(Math.max(input.limit ?? 30, 1), 100),
        before: before && !Number.isNaN(before.getTime()) ? before : undefined,
      }),
    );
  }
}
