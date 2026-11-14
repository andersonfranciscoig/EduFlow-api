import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { PortalAccessRepository } from "../application/PortalAccess";

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export class PrismaPortalAccess implements PortalAccessRepository {
  constructor(private readonly db: PrismaClient) {}

  employee(id: string) {
    return this.db.employee.findUnique({ where: { id }, select: { id: true, fullName: true, email: true, status: true, userId: true } });
  }

  private async userRow(where: { id: string } | { email: string }) {
    const u = await this.db.schoolUser.findUnique({ where, select: { id: true, status: true, isOwner: true, employee: { select: { id: true } } } });
    return u ? { id: u.id, status: u.status, isOwner: u.isOwner, employeeId: u.employee?.id ?? null } : null;
  }

  userByEmail(email: string) {
    return this.userRow({ email: email.toLowerCase() });
  }

  user(id: string) {
    return this.userRow({ id });
  }

  async link(employeeId: string, userId: string) {
    try {
      await this.db.employee.update({ where: { id: employeeId }, data: { userId } });
      return { ok: true as const };
    } catch (e) {
      if (isUnique(e)) return { ok: false as const, reason: "taken" as const };
      throw e;
    }
  }

  async unlink(employeeId: string) {
    await this.db.employee.update({ where: { id: employeeId }, data: { userId: null } });
  }

  async addHistory(h: { employeeId: string; status: string; actorId: string | null; actorName: string | null; reason: string; now: Date }) {
    await this.db.employeeApprovalHistory.create({
      data: { id: randomUUID(), subjectType: "EMPLOYEE", subjectId: h.employeeId, fromStatus: h.status, toStatus: h.status, actorId: h.actorId, actorName: h.actorName, reason: h.reason, createdAt: h.now },
    });
  }
}
