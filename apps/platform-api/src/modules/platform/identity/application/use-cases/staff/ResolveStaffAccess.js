"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResolveStaffAccess = void 0;
class ResolveStaffAccess {
    members;
    constructor(members) {
        this.members = members;
    }
    async execute(input) {
        const member = await this.members.findById(input.id);
        if (!member || member.status !== "ACTIVE")
            return null;
        return { id: member.id, fullName: member.fullName.value, role: member.role, permissions: member.permissions };
    }
}
exports.ResolveStaffAccess = ResolveStaffAccess;
//# sourceMappingURL=ResolveStaffAccess.js.map