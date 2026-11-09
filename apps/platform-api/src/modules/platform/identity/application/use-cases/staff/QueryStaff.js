"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetStaffActivity = exports.GetStaffMember = exports.ListStaffMembers = void 0;
const Result_1 = require("../../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../../../domain/errors");
const staff_dto_1 = require("../../staff-dto");
class ListStaffMembers {
    members;
    constructor(members) {
        this.members = members;
    }
    async execute(filter = {}) {
        const all = await this.members.list();
        const filtered = all.filter((m) => (!filter.status || m.status === filter.status) && (!filter.role || m.role === filter.role));
        return {
            members: filtered.map(staff_dto_1.toStaffSummary),
            totals: {
                all: all.length,
                active: all.filter((m) => m.status === "ACTIVE").length,
                pending: all.filter((m) => m.status === "PENDING_APPROVAL").length,
                suspended: all.filter((m) => m.status === "SUSPENDED").length,
            },
        };
    }
}
exports.ListStaffMembers = ListStaffMembers;
class GetStaffMember {
    members;
    constructor(members) {
        this.members = members;
    }
    async execute(input) {
        const member = await this.members.findById(input.id);
        if (!member)
            return (0, Result_1.fail)((0, errors_1.identityError)("MEMBER_NOT_FOUND", "Membro não encontrado."));
        return (0, Result_1.ok)((0, staff_dto_1.toStaffProfile)(member));
    }
}
exports.GetStaffMember = GetStaffMember;
class GetStaffActivity {
    members;
    activity;
    constructor(members, activity) {
        this.members = members;
        this.activity = activity;
    }
    async execute(input) {
        if (!(await this.members.findById(input.id))) {
            return (0, Result_1.fail)((0, errors_1.identityError)("MEMBER_NOT_FOUND", "Membro não encontrado."));
        }
        const before = input.before ? new Date(input.before) : undefined;
        return (0, Result_1.ok)(await this.activity.forMember(input.id, {
            limit: Math.min(Math.max(input.limit ?? 30, 1), 100),
            before: before && !Number.isNaN(before.getTime()) ? before : undefined,
        }));
    }
}
exports.GetStaffActivity = GetStaffActivity;
//# sourceMappingURL=QueryStaff.js.map