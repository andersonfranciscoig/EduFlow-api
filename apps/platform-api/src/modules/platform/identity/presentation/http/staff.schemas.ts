import { z } from "zod";
import { PERMISSION_CATALOG, PERMISSIONS, STAFF_ROLES, STAFF_STATUSES } from "../../domain/access-control";
import { STAFF_ACTIVITY_TYPES } from "../../domain/events";

/** Contratos HTTP da gestão da equipa. */

// ------------------------------------------------------------------ entrada

export const memberIdSchema = z.uuid({ error: "Identificador de membro inválido." });

export const listStaffQuerySchema = z
  .object({
    status: z.enum(STAFF_STATUSES).optional(),
    role: z.enum(STAFF_ROLES).optional(),
  })
  .meta({ title: "ListStaffQuery" });

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.iso.datetime().optional().meta({ description: "Paginação: entradas anteriores a esta data" }),
});

export const changeRoleSchema = z
  .object({ role: z.enum(STAFF_ROLES, { error: "Papel inválido." }) })
  .meta({ title: "ChangeRoleRequest" });

export const setPermissionsSchema = z
  .object({
    permissions: z
      .array(z.string())
      .max(PERMISSIONS.length)
      .meta({ description: "Permissões extra (além das do papel)", example: ["schools.view", "staff.view"] }),
  })
  .meta({ title: "SetPermissionsRequest" });

export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
export type ChangeRoleBody = z.infer<typeof changeRoleSchema>;
export type SetPermissionsBody = z.infer<typeof setPermissionsSchema>;

// ------------------------------------------------------------------ saída (docs)

const staffSummary = z.object({
  id: z.uuid(),
  fullName: z.string(),
  initials: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.enum(STAFF_ROLES),
  roleLabel: z.string(),
  status: z.enum(STAFF_STATUSES),
  statusLabel: z.string(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export const staffListResponseSchema = z
  .object({
    members: z.array(staffSummary),
    totals: z.object({ all: z.number(), active: z.number(), pending: z.number(), suspended: z.number() }),
  })
  .meta({ title: "StaffListResponse" });

export const staffDetailSchema = staffSummary
  .extend({
    firstName: z.string(),
    permissions: z.array(z.enum(PERMISSIONS as [string, ...string[]])),
    rolePermissions: z.array(z.string()),
    extraPermissions: z.array(z.string()),
    lockedUntil: z.string().nullable(),
  })
  .meta({ title: "StaffMemberDetail" });

export const activityResponseSchema = z
  .array(
    z.object({
      id: z.uuid(),
      type: z.enum(STAFF_ACTIVITY_TYPES),
      occurredAt: z.string(),
      details: z.record(z.string(), z.unknown()).nullable(),
      performedByMember: z.boolean(),
      actor: z.object({ id: z.string(), fullName: z.string() }).nullable(),
      subject: z.object({ id: z.string(), fullName: z.string() }),
    }),
  )
  .meta({ title: "StaffActivity" });

export const permissionCatalogSchema = z
  .array(
    z.object({
      key: z.string(),
      group: z.string(),
      label: z.string(),
      description: z.string(),
    }),
  )
  .meta({ title: "PermissionCatalog", example: PERMISSION_CATALOG.slice(0, 2) });
