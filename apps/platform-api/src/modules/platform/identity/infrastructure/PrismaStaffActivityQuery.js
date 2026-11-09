"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaStaffActivityQuery = void 0;
const events_1 = require("../domain/events");
class PrismaStaffActivityQuery {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async forMember(memberId, options) {
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
            .filter((r) => events_1.STAFF_ACTIVITY_TYPES.includes(r.type))
            .map((r) => ({
            id: r.id,
            type: r.type,
            occurredAt: r.occurredAt.toISOString(),
            details: r.details ?? null,
            performedByMember: r.actorId === memberId,
            actor: r.actor,
            subject: r.subject,
        }));
    }
}
exports.PrismaStaffActivityQuery = PrismaStaffActivityQuery;
//# sourceMappingURL=PrismaStaffActivityQuery.js.map