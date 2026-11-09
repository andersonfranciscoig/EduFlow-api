"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SetStaffPermissions = exports.ChangeStaffRole = exports.SuspendStaffMember = exports.ActivateStaffMember = void 0;
const Result_1 = require("../../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../../../domain/errors");
const staff_dto_1 = require("../../staff-dto");
class StaffCommand {
    members;
    clock;
    constructor(members, clock) {
        this.members = members;
        this.clock = clock;
    }
    async execute(input) {
        const [actor, member] = await Promise.all([
            this.members.findById(input.actorId),
            this.members.findById(input.memberId),
        ]);
        if (!actor || actor.status !== "ACTIVE") {
            return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_NOT_FOUND", "Sessão inválida."));
        }
        if (!member)
            return (0, Result_1.fail)((0, errors_1.identityError)("MEMBER_NOT_FOUND", "Membro não encontrado."));
        const ctx = {
            actor,
            activeAdminCount: await this.members.countActiveAdmins(),
            now: this.clock.now(),
        };
        const result = this.apply(member, input, ctx);
        if (!result.ok)
            return result;
        await this.members.save(member);
        return (0, Result_1.ok)((0, staff_dto_1.toStaffProfile)(member));
    }
}
class ActivateStaffMember extends StaffCommand {
    apply(member, _, ctx) {
        return member.activate(ctx);
    }
}
exports.ActivateStaffMember = ActivateStaffMember;
class SuspendStaffMember extends StaffCommand {
    apply(member, _, ctx) {
        return member.suspend(ctx);
    }
}
exports.SuspendStaffMember = SuspendStaffMember;
class ChangeStaffRole extends StaffCommand {
    apply(member, input, ctx) {
        return member.changeRole(input.role, ctx);
    }
}
exports.ChangeStaffRole = ChangeStaffRole;
class SetStaffPermissions extends StaffCommand {
    apply(member, input, ctx) {
        return member.setExtraPermissions(input.permissions, ctx);
    }
}
exports.SetStaffPermissions = SetStaffPermissions;
//# sourceMappingURL=ManageStaffMember.js.map