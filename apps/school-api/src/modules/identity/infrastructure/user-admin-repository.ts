import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { UserAdminRepository, UserAdminRow } from "../application/ManageUsers";
import type { Permission } from "../domain/permissions";
import type { SchoolRole, SchoolUserStatus } from "../domain/SchoolUser";

const SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  isOwner: true,
  mfaEnabledAt: true,
  lastLoginAt: true,
  createdAt: true,
  permissions: { select: { permission: true }, orderBy: { permission: "asc" } },
} as const satisfies Prisma.SchoolUserSelect;

type Row = Prisma.SchoolUserGetPayload<{ select: typeof SELECT }>;

const toRow = (u: Row): UserAdminRow => ({
  id: u.id,
  fullName: u.fullName,
  email: u.email,
  phone: u.phone,
  role: u.role as SchoolRole,
  status: u.status as SchoolUserStatus,
  isOwner: u.isOwner,
  mfaEnabled: !!u.mfaEnabledAt,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
  permissions: u.permissions.map((p) => p.permission),
});

export class PrismaUserAdminRepository implements UserAdminRepository {
  constructor(private readonly db: PrismaClient) {}

  async list() {
    const rows = await this.db.schoolUser.findMany({ select: SELECT, orderBy: [{ isOwner: "desc" }, { fullName: "asc" }] });
    return rows.map(toRow);
  }

  async find(id: string) {
    const row = await this.db.schoolUser.findUnique({ where: { id }, select: SELECT });
    return row ? toRow(row) : null;
  }

  async create(input: { id: string; fullName: string; email: string; role: SchoolRole; permissions: Permission[]; grantedById: string; now: Date }) {
    try {
      const row = await this.db.$transaction(async (tx) => {
        await tx.schoolUser.create({ data: { id: input.id, fullName: input.fullName, email: input.email, role: input.role, status: "INVITED", createdAt: input.now, updatedAt: input.now } });
        if (input.permissions.length) {
          await tx.schoolUserPermission.createMany({ data: input.permissions.map((permission) => ({ userId: input.id, permission, grantedById: input.grantedById, grantedAt: input.now })) });
        }
        return tx.schoolUser.findUniqueOrThrow({ where: { id: input.id }, select: SELECT });
      });
      return { ok: true as const, value: toRow(row) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false as const, reason: "email_taken" as const };
      throw e;
    }
  }

  async update(id: string, input: { role: SchoolRole; permissions: Permission[]; grantedById: string; now: Date }) {
    const row = await this.db.$transaction(async (tx) => {
      await tx.schoolUser.update({ where: { id }, data: { role: input.role, updatedAt: input.now } });
      // mantém a data de quem já tinha a permissão; tira as que saíram; junta as novas
      await tx.schoolUserPermission.deleteMany({ where: { userId: id, permission: { notIn: input.permissions } } });
      if (input.permissions.length) {
        await tx.schoolUserPermission.createMany({
          data: input.permissions.map((permission) => ({ userId: id, permission, grantedById: input.grantedById, grantedAt: input.now })),
          skipDuplicates: true,
        });
      }
      return tx.schoolUser.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
    return toRow(row);
  }

  async setStatus(id: string, status: SchoolUserStatus, now: Date) {
    const row = await this.db.$transaction(async (tx) => {
      await tx.schoolUser.update({ where: { id }, data: { status, updatedAt: now } });
      // suspender corta logo o acesso: as sessões abertas deixam de valer
      if (status === "SUSPENDED") await tx.schoolSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now, revokedReason: "account_suspended" } });
      return tx.schoolUser.findUniqueOrThrow({ where: { id }, select: SELECT });
    });
    return toRow(row);
  }

  async deleteInvited(id: string) {
    const r = await this.db.schoolUser.deleteMany({ where: { id, status: "INVITED", isOwner: false, passwordHash: null } });
    return r.count > 0;
  }

  async record(type: string, subjectId: string, actorId: string, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
