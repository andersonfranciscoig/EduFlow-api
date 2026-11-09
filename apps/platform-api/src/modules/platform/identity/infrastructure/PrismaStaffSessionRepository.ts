import type { PrismaClient } from ".prisma/platform-client";
import { StaffSession, type StaffSessionRepository } from "../domain/StaffSession";

export class PrismaStaffSessionRepository implements StaffSessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const row = await this.prisma.staffSession.findUnique({ where: { id } });
    return row ? StaffSession.restore(row) : null;
  }

  async listActive(staffId: string, now: Date) {
    const rows = await this.prisma.staffSession.findMany({
      where: { staffId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
    });
    return rows.map((r) => StaffSession.restore(r));
  }

  async save(session: StaffSession) {
    const { id, ...data } = session.snapshot;
    await this.prisma.staffSession.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  async touch(id: string, now: Date) {
    await this.prisma.staffSession.update({ where: { id }, data: { lastSeenAt: now } });
  }

  async revokeAll(staffId: string, reason: string, now: Date, exceptId?: string) {
    const { count } = await this.prisma.staffSession.updateMany({
      where: { staffId, revokedAt: null, expiresAt: { gt: now }, ...(exceptId && { NOT: { id: exceptId } }) },
      data: { revokedAt: now, revokedReason: reason },
    });
    return count;
  }
}
