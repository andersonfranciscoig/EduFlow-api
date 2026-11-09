"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionCatalogSchema = exports.activityResponseSchema = exports.staffDetailSchema = exports.staffListResponseSchema = exports.setPermissionsSchema = exports.changeRoleSchema = exports.activityQuerySchema = exports.listStaffQuerySchema = exports.memberIdSchema = void 0;
const zod_1 = require("zod");
const access_control_1 = require("../../domain/access-control");
const events_1 = require("../../domain/events");
exports.memberIdSchema = zod_1.z.uuid({ error: "Identificador de membro inválido." });
exports.listStaffQuerySchema = zod_1.z
    .object({
    status: zod_1.z.enum(access_control_1.STAFF_STATUSES).optional(),
    role: zod_1.z.enum(access_control_1.STAFF_ROLES).optional(),
})
    .meta({ title: "ListStaffQuery" });
exports.activityQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
    before: zod_1.z.iso.datetime().optional().meta({ description: "Paginação: entradas anteriores a esta data" }),
});
exports.changeRoleSchema = zod_1.z
    .object({ role: zod_1.z.enum(access_control_1.STAFF_ROLES, { error: "Papel inválido." }) })
    .meta({ title: "ChangeRoleRequest" });
exports.setPermissionsSchema = zod_1.z
    .object({
    permissions: zod_1.z
        .array(zod_1.z.string())
        .max(access_control_1.PERMISSIONS.length)
        .meta({ description: "Permissões extra (além das do papel)", example: ["schools.view", "staff.view"] }),
})
    .meta({ title: "SetPermissionsRequest" });
const staffSummary = zod_1.z.object({
    id: zod_1.z.uuid(),
    fullName: zod_1.z.string(),
    initials: zod_1.z.string(),
    email: zod_1.z.string().nullable(),
    phone: zod_1.z.string().nullable(),
    role: zod_1.z.enum(access_control_1.STAFF_ROLES),
    roleLabel: zod_1.z.string(),
    status: zod_1.z.enum(access_control_1.STAFF_STATUSES),
    statusLabel: zod_1.z.string(),
    lastLoginAt: zod_1.z.string().nullable(),
    createdAt: zod_1.z.string(),
});
exports.staffListResponseSchema = zod_1.z
    .object({
    members: zod_1.z.array(staffSummary),
    totals: zod_1.z.object({ all: zod_1.z.number(), active: zod_1.z.number(), pending: zod_1.z.number(), suspended: zod_1.z.number() }),
})
    .meta({ title: "StaffListResponse" });
exports.staffDetailSchema = staffSummary
    .extend({
    firstName: zod_1.z.string(),
    permissions: zod_1.z.array(zod_1.z.enum(access_control_1.PERMISSIONS)),
    rolePermissions: zod_1.z.array(zod_1.z.string()),
    extraPermissions: zod_1.z.array(zod_1.z.string()),
    lockedUntil: zod_1.z.string().nullable(),
})
    .meta({ title: "StaffMemberDetail" });
exports.activityResponseSchema = zod_1.z
    .array(zod_1.z.object({
    id: zod_1.z.uuid(),
    type: zod_1.z.enum(events_1.STAFF_ACTIVITY_TYPES),
    occurredAt: zod_1.z.string(),
    details: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).nullable(),
    performedByMember: zod_1.z.boolean(),
    actor: zod_1.z.object({ id: zod_1.z.string(), fullName: zod_1.z.string() }).nullable(),
    subject: zod_1.z.object({ id: zod_1.z.string(), fullName: zod_1.z.string() }),
}))
    .meta({ title: "StaffActivity" });
exports.permissionCatalogSchema = zod_1.z
    .array(zod_1.z.object({
    key: zod_1.z.string(),
    group: zod_1.z.string(),
    label: zod_1.z.string(),
    description: zod_1.z.string(),
}))
    .meta({ title: "PermissionCatalog", example: access_control_1.PERMISSION_CATALOG.slice(0, 2) });
//# sourceMappingURL=staff.schemas.js.map