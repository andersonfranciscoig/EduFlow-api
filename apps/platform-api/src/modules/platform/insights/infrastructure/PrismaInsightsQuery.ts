import type { PrismaClient } from ".prisma/platform-client";
import type { BillingFigures, DatabaseFigures, InsightsQuery, OwnAccessFigures, SchoolFigures, TeamFigures } from "../application/ports";

const DAY_MS = 86_400_000;

/**
 * Agregados para a visão geral — só contagens e somas, nunca linhas com dados
 * pessoais. As colunas de data guardam UTC (timestamp sem fuso); os meses e
 * dias são agrupados em hora de Luanda.
 */
export class PrismaInsightsQuery implements InsightsQuery {
  constructor(private readonly db: PrismaClient) {}

  async schools(from: Date, now: Date): Promise<SchoolFigures> {
    const [byStatus, registered, activated, byProvince, expiringSoon] = await Promise.all([
      this.db.school.groupBy({ by: ["status"], _count: { _all: true } }),
      this.db.$queryRaw<{ key: string; count: number }[]>`
        SELECT to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda', 'YYYY-MM') AS key, count(*)::int AS count
        FROM schools WHERE created_at >= ${from} GROUP BY 1`,
      // ativação = primeiro pagamento confirmado de cada colégio
      this.db.$queryRaw<{ key: string; count: number }[]>`
        SELECT to_char(first_paid AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda', 'YYYY-MM') AS key, count(*)::int AS count
        FROM (SELECT min(paid_at) AS first_paid FROM subscription_orders WHERE status = 'PAID' AND paid_at IS NOT NULL GROUP BY school_id) t
        WHERE first_paid >= ${from} GROUP BY 1`,
      this.db.school.groupBy({ by: ["province"], where: { status: "ACTIVE" }, _count: { _all: true } }),
      this.db.school.count({ where: { status: "ACTIVE", subscriptionEndsAt: { gte: now, lte: new Date(now.getTime() + 30 * DAY_MS) } } }),
    ]);
    return {
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      registered,
      activated,
      byProvince: byProvince.map((r) => ({ province: r.province, count: r._count._all })),
      expiringSoon,
    };
  }

  async billing(from: Date): Promise<BillingFigures> {
    const [activeSubscriptions, paid, byMethod, outstanding, proofsToCheck] = await Promise.all([
      // a subscrição em vigor de cada colégio ativo = o último pagamento confirmado
      this.db.$queryRaw<{ plan_name: string; total: number; months: number }[]>`
        SELECT DISTINCT ON (o.school_id) o.plan_name, o.total, o.months
        FROM subscription_orders o JOIN schools s ON s.id = o.school_id
        WHERE s.status = 'ACTIVE' AND o.status = 'PAID'
        ORDER BY o.school_id, o.paid_at DESC NULLS LAST`,
      this.db.$queryRaw<{ key: string; amount: bigint; count: number }[]>`
        SELECT to_char(paid_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda', 'YYYY-MM') AS key, sum(total)::bigint AS amount, count(*)::int AS count
        FROM subscription_orders WHERE status = 'PAID' AND paid_at >= ${from} GROUP BY 1`,
      this.db.subscriptionOrder.groupBy({ by: ["paymentMethod"], where: { status: "PAID", paidAt: { gte: from } }, _sum: { total: true }, _count: { _all: true } }),
      this.db.subscriptionOrder.aggregate({ where: { status: { in: ["AWAITING_PAYMENT", "PROOF_SUBMITTED"] } }, _sum: { total: true }, _count: { _all: true } }),
      this.db.subscriptionOrder.count({ where: { status: "PROOF_SUBMITTED" } }),
    ]);
    return {
      activeSubscriptions: activeSubscriptions.map((s) => ({ planName: s.plan_name, total: s.total, months: s.months })),
      paid: paid.map((p) => ({ key: p.key, amount: Number(p.amount), count: p.count })),
      byMethod: byMethod.map((m) => ({ method: m.paymentMethod, amount: m._sum.total ?? 0, count: m._count._all })),
      outstanding: { amount: outstanding._sum.total ?? 0, count: outstanding._count._all },
      proofsToCheck,
    };
  }

  async team(from: Date, now: Date): Promise<TeamFigures> {
    const [members, mfaEnabled, pendingInvitations, signIns, active] = await Promise.all([
      this.db.staffMember.groupBy({ by: ["role", "status"], _count: { _all: true } }),
      this.db.staffMember.count({ where: { status: "ACTIVE", mfaEnabledAt: { not: null } } }),
      this.db.staffInvitation.count({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
      this.db.$queryRaw<{ key: string; count: number; people: number }[]>`
        SELECT to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda', 'YYYY-MM-DD') AS key,
               count(*)::int AS count, count(DISTINCT staff_id)::int AS people
        FROM staff_sessions WHERE created_at >= ${from} GROUP BY 1`,
      this.db.$queryRaw<{ n: number }[]>`
        SELECT count(DISTINCT staff_id)::int AS n FROM staff_sessions WHERE last_seen_at >= ${new Date(now.getTime() - 7 * DAY_MS)}`,
    ]);
    return {
      members: members.map((m) => ({ role: m.role, status: m.status, count: m._count._all })),
      mfaEnabled,
      pendingInvitations,
      signIns,
      activeLast7Days: active[0]?.n ?? 0,
    };
  }

  async databases(from: Date): Promise<DatabaseFigures> {
    const [byHealth, capacity, assigned, backups] = await Promise.all([
      this.db.databaseServer.groupBy({ by: ["health"], where: { status: "ACTIVE" }, _count: { _all: true } }),
      this.db.databaseServer.aggregate({ where: { status: "ACTIVE" }, _sum: { capacity: true } }),
      this.db.databaseAllocation.count({ where: { status: "ASSIGNED", server: { status: "ACTIVE" } } }),
      // DELETED = cópia feita que já saiu do armazenamento (fim da retenção): conta como feita
      this.db.$queryRaw<{ key: string; done: number; failed: number }[]>`
        SELECT to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda', 'YYYY-MM-DD') AS key,
               count(*) FILTER (WHERE status IN ('DONE', 'DELETED'))::int AS done,
               count(*) FILTER (WHERE status = 'FAILED')::int AS failed
        FROM database_backups WHERE created_at >= ${from} GROUP BY 1`,
    ]);
    return {
      serversByHealth: byHealth.map((h) => ({ health: h.health, count: h._count._all })),
      capacity: capacity._sum.capacity ?? 0,
      assigned,
      backups,
    };
  }

  async ownAccess(staffId: string, now: Date): Promise<OwnAccessFigures> {
    const [me, activeSessions] = await Promise.all([
      this.db.staffMember.findUnique({ where: { id: staffId }, select: { mfaEnabledAt: true, lastLoginAt: true } }),
      this.db.staffSession.count({ where: { staffId, revokedAt: null, expiresAt: { gt: now } } }),
    ]);
    return { mfaEnabledAt: me?.mfaEnabledAt ?? null, activeSessions, lastLoginAt: me?.lastLoginAt ?? null };
  }
}
