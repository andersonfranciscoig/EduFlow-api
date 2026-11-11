import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type SupportSession as Row } from ".prisma/tenant-client";
import type { SupportMode, SupportRepository, SupportSessionRow } from "../application/ports";

const toRow = (r: Row): SupportSessionRow => ({
  id: r.id,
  staffId: r.staffId,
  staffName: r.staffName,
  mode: r.mode as SupportMode,
  emergency: r.emergency,
  reason: r.reason,
  grantId: r.grantId,
  createdAt: r.createdAt,
  lastSeenAt: r.lastSeenAt,
  expiresAt: r.expiresAt,
  revokedAt: r.revokedAt,
});

export class PrismaSupportRepository implements SupportRepository {
  constructor(private readonly db: PrismaClient) {}

  async activeGrant(now: Date) {
    const g = await this.db.supportGrant.findFirst({ where: { revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
    if (!g) return null;
    const by = await this.db.schoolUser.findUnique({ where: { id: g.grantedById }, select: { fullName: true } });
    return { id: g.id, grantedBy: by?.fullName ?? null, expiresAt: g.expiresAt, createdAt: g.createdAt };
  }

  async grant(input: { id: string; grantedById: string; expiresAt: Date; now: Date }) {
    await this.db.supportGrant.create({ data: { id: input.id, grantedById: input.grantedById, expiresAt: input.expiresAt, createdAt: input.now } });
  }

  async revokeAll(input: { revokedById: string; reason: string; now: Date }) {
    const [, sessions] = await this.db.$transaction([
      this.db.supportGrant.updateMany({ where: { revokedAt: null, expiresAt: { gt: input.now } }, data: { revokedAt: input.now, revokedById: input.revokedById } }),
      this.db.supportSession.updateMany({ where: { revokedAt: null, expiresAt: { gt: input.now } }, data: { revokedAt: input.now, revokedReason: input.reason } }),
    ]);
    return sessions.count;
  }

  async createSession(row: Parameters<SupportRepository["createSession"]>[0]) {
    // caso normal de reutilização (sem erro no log); a garantia é o índice único abaixo
    if (await this.db.supportSession.findUnique({ where: { ticketId: row.ticketId }, select: { id: true } })) return false;
    try {
      await this.db.supportSession.create({ data: { ...row } });
      return true;
    } catch (error) {
      // ticket_id único: o mesmo bilhete não abre duas sessões
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async findSession(id: string) {
    const r = await this.db.supportSession.findUnique({ where: { id } });
    return r ? toRow(r) : null;
  }

  async touchSession(id: string, now: Date) {
    await this.db.supportSession.update({ where: { id }, data: { lastSeenAt: now } });
  }

  async revokeSession(id: string, reason: string, now: Date) {
    await this.db.supportSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
  }

  async recentSessions(limit: number) {
    return (await this.db.supportSession.findMany({ orderBy: { createdAt: "desc" }, take: limit })).map(toRow);
  }

  async recipients() {
    const users = await this.db.schoolUser.findMany({
      where: { status: "ACTIVE", email: { not: null }, OR: [{ role: "DIRETOR" }, { isOwner: true }] },
      select: { email: true, fullName: true },
      take: 20,
    });
    return users.map((u) => ({ email: u.email!, name: u.fullName }));
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({
      data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now },
    });
  }
}
