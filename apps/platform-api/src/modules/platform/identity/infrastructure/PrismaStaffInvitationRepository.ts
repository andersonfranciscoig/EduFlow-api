import type { PrismaClient } from ".prisma/platform-client";
import { StaffInvitation, type StaffInvitationRepository } from "../domain/StaffInvitation";

export class PrismaStaffInvitationRepository implements StaffInvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private pendingWhere(now: Date) {
    return { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } };
  }

  async findPendingByEmail(email: string, now: Date) {
    const row = await this.prisma.staffInvitation.findFirst({ where: { email, ...this.pendingWhere(now) }, orderBy: { createdAt: "desc" } });
    return row ? StaffInvitation.restore(row) : null;
  }

  async findByTokenHash(tokenHash: string) {
    const row = await this.prisma.staffInvitation.findUnique({ where: { tokenHash } });
    return row ? StaffInvitation.restore(row) : null;
  }

  async findById(id: string) {
    const row = await this.prisma.staffInvitation.findUnique({ where: { id } });
    return row ? StaffInvitation.restore(row) : null;
  }

  async pendingForEmail(email: string, now: Date) {
    const rows = await this.prisma.staffInvitation.findMany({ where: { email, ...this.pendingWhere(now) } });
    return rows.map((r) => StaffInvitation.restore(r));
  }

  async listPending(now: Date) {
    const rows = await this.prisma.staffInvitation.findMany({ where: this.pendingWhere(now), orderBy: { createdAt: "desc" } });
    const ids = [...new Set(rows.map((r) => r.invitedById))];
    const people = ids.length ? await this.prisma.staffMember.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
    const names = new Map(people.map((p) => [p.id, p.fullName]));
    return rows.map((r) => ({ invitation: StaffInvitation.restore(r), invitedByName: names.get(r.invitedById) ?? null }));
  }

  async save(invitation: StaffInvitation) {
    const { id, ...data } = invitation.snapshot;
    await this.prisma.staffInvitation.upsert({ where: { id }, create: { id, ...data }, update: { acceptedAt: data.acceptedAt, revokedAt: data.revokedAt } });
  }
}
