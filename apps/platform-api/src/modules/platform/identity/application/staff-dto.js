"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toStaffSummary = toStaffSummary;
exports.toStaffProfile = toStaffProfile;
const access_control_1 = require("../domain/access-control");
function initialsOf(fullName) {
    const parts = fullName.split(" ");
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
function toStaffSummary(member) {
    return {
        id: member.id,
        fullName: member.fullName.value,
        initials: initialsOf(member.fullName.value),
        email: member.email?.value ?? null,
        phone: member.phone?.value ?? null,
        role: member.role,
        roleLabel: access_control_1.ROLE_LABELS[member.role],
        status: member.status,
        statusLabel: access_control_1.STATUS_LABELS[member.status],
        lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
        createdAt: member.createdAt.toISOString(),
    };
}
function toStaffProfile(member) {
    return {
        ...toStaffSummary(member),
        firstName: member.fullName.firstName,
        permissions: member.permissions,
        rolePermissions: (0, access_control_1.rolePermissions)(member.role),
        extraPermissions: member.extraPermissions,
        lockedUntil: member.lockedUntil?.toISOString() ?? null,
    };
}
//# sourceMappingURL=staff-dto.js.map