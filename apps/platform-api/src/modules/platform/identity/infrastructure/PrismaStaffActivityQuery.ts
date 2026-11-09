import type { PrismaClient } from ".prisma/platform-client";
import type { StaffActivityEntry, StaffActivityQuery } from "../application/ports";
import { STAFF_ACTIVITY_TYPES, type StaffActivityType } from "../domain/events";

/**
 * Read model do histórico: lê diretamente as tabelas, já com os nomes de
 * quem fez e de quem sofreu a ação (sem passar pelo agregado).
 */
export class PrismaStaffActivityQuery implements StaffActivityQuery {
  constructor(private readonly prisma: PrismaClient) {}

  async forMember(memberId: string, options: { limit: number; before?: Date }): Promise<StaffActivityEntry[]> {
    const rows = await this.prisma.staffActivity.findMany({
      where: {
        OR: [{ subjectId: memberId }, { actorId: memberId }],
        ...(options.before && { occurredAt: { lt: options.before } }),
      },
      orderBy: { occurredAt: "desc" },
      take: options.limit,
      include: {
        actor: { select: { id: true, fullName: true } },
        subject: { select: { id: true, fullName: true } },
      },
    });

    return rows
      .filter((r) => (STAFF_ACTIVITY_TYPES as readonly string[]).includes(r.type))
      .map((r) => ({
        id: r.id,
        type: r.type as StaffActivityType,
        occurredAt: r.occurredAt.toISOString(),
        details: (r.details as Record<string, unknown> | null) ?? null,
        performedByMember: r.actorId === memberId,
        actor: r.actor,
        subject: r.subject,
      }));
  }
}
