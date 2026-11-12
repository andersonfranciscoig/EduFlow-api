import type { Clock } from "../../../../../../../libs/kernel/src/application/ports";
import type { StaffAccess } from "../../identity/application/ports";
import { PERMISSION_CATALOG, ROLE_LABELS, type StaffRole } from "../../identity/domain/access-control";
import { SCHOOL_STATUS_LABELS } from "../../schools/application/school-dto";
import { change, dayStart, fill, lastDays, lastMonths, monthKey, monthlyEquivalent, monthStart } from "../domain/series";
import type { InsightsQuery } from "./ports";

const SCHOOL_STATUS_ORDER = ["ACTIVE", "PENDING_REVIEW", "AWAITING_PAYMENT", "PAYMENT_UNDER_REVIEW", "SUSPENDED", "REJECTED"] as const;
const METHOD_LABELS: Record<string, string> = { REFERENCE: "Referência", TRANSFER: "Transferência" };
const HEALTH_ORDER = ["HEALTHY", "DEGRADED", "UNREACHABLE", "UNKNOWN"] as const;
const HEALTH_LABELS: Record<string, string> = { HEALTHY: "Saudável", DEGRADED: "Lento", UNREACHABLE: "Inacessível", UNKNOWN: "Por testar" };
const PROVINCES_SHOWN = 6;

/**
 * Visão geral do painel: um pedido, várias secções. Cada secção só é lida e
 * devolvida se o membro tiver a permissão de "ver" dessa área — quem não pode
 * ver a faturação nem sequer faz a consulta de faturação.
 */
export class PlatformOverview {
  constructor(
    private readonly query: InsightsQuery,
    private readonly clock: Clock,
  ) {}

  async execute(staff: StaffAccess) {
    const now = this.clock.now();
    const months = lastMonths(now, 12);
    const days30 = lastDays(now, 30);
    const days14 = lastDays(now, 14);
    const can = (p: string) => staff.permissions.includes(p as never);

    const [access, schools, billing, team, databases] = await Promise.all([
      this.access(staff, now),
      can("schools.view") ? this.schools(months, now) : null,
      can("billing.view") ? this.billing(months, now) : null,
      can("staff.view") ? this.team(days30, now) : null,
      can("databases.view") ? this.databases(days14) : null,
    ]);
    return { generatedAt: now.toISOString(), access, schools, billing, team, databases };
  }

  private async access(staff: StaffAccess, now: Date) {
    const own = await this.query.ownAccess(staff.id, now);
    const groups = [...new Set(PERMISSION_CATALOG.map((p) => p.group))].map((group) => {
      const inGroup = PERMISSION_CATALOG.filter((p) => p.group === group);
      return { group, granted: inGroup.filter((p) => staff.permissions.includes(p.key)).length, total: inGroup.length };
    });
    return {
      role: staff.role,
      roleLabel: ROLE_LABELS[staff.role],
      permissions: { granted: staff.permissions.length, total: PERMISSION_CATALOG.length, groups },
      mfaEnabled: !!own.mfaEnabledAt,
      activeSessions: own.activeSessions,
      lastLoginAt: own.lastLoginAt?.toISOString() ?? null,
    };
  }

  private async schools(months: string[], now: Date) {
    const f = await this.query.schools(monthStart(months[0]), now);
    const count = (s: string) => f.byStatus.find((r) => r.status === s)?.count ?? 0;
    const registered = fill(months, f.registered, ["count"]);
    const activated = fill(months, f.activated, ["count"]);

    const provinces = [...f.byProvince].sort((a, b) => b.count - a.count || a.province.localeCompare(b.province, "pt"));
    const rest = provinces.slice(PROVINCES_SHOWN).reduce((n, p) => n + p.count, 0);

    return {
      active: count("ACTIVE"),
      total: f.byStatus.reduce((n, r) => n + r.count, 0),
      activatedThisMonth: activated.at(-1)?.count ?? 0,
      toReview: count("PENDING_REVIEW"),
      paymentsToCheck: count("PAYMENT_UNDER_REVIEW"),
      expiringSoon: f.expiringSoon,
      byStatus: SCHOOL_STATUS_ORDER.map((status) => ({ status, label: SCHOOL_STATUS_LABELS[status], count: count(status) })),
      monthly: months.map((month, i) => ({ month, registered: registered[i].count, activated: activated[i].count })),
      byProvince: [...provinces.slice(0, PROVINCES_SHOWN), ...(rest ? [{ province: "Outras", count: rest }] : [])],
    };
  }

  private async billing(months: string[], now: Date) {
    const f = await this.query.billing(monthStart(months[0]));
    const paid = fill(months, f.paid, ["amount", "count"]);

    // receita recorrente: o valor mensal da subscrição em vigor de cada colégio ativo
    const plans = new Map<string, { amount: number; schools: number }>();
    for (const s of f.activeSubscriptions) {
      const p = plans.get(s.planName) ?? { amount: 0, schools: 0 };
      p.amount += monthlyEquivalent(s.total, s.months);
      p.schools += 1;
      plans.set(s.planName, p);
    }
    const mrrByPlan = [...plans].map(([plan, v]) => ({ plan, ...v })).sort((a, b) => b.amount - a.amount);

    const thisMonth = paid.find((p) => p.key === monthKey(now))?.amount ?? 0;
    const lastMonth = paid.at(-2)?.amount ?? 0;
    return {
      mrr: mrrByPlan.reduce((n, p) => n + p.amount, 0),
      paidThisMonth: thisMonth,
      paidLastMonth: lastMonth,
      change: change(thisMonth, lastMonth),
      monthly: paid.map((p) => ({ month: p.key, amount: p.amount, count: p.count })),
      mrrByPlan,
      byMethod: f.byMethod
        .filter((m) => m.method)
        .map((m) => ({ method: m.method!, label: METHOD_LABELS[m.method!] ?? m.method!, amount: m.amount, count: m.count }))
        .sort((a, b) => b.amount - a.amount),
      outstanding: f.outstanding,
      proofsToCheck: f.proofsToCheck,
    };
  }

  private async team(days: string[], now: Date) {
    const f = await this.query.team(dayStart(days[0]), now);
    const sum = (pred: (m: { role: string; status: string }) => boolean) => f.members.filter(pred).reduce((n, m) => n + m.count, 0);
    const daily = fill(days, f.signIns, ["count", "people"]);
    return {
      active: sum((m) => m.status === "ACTIVE"),
      total: sum(() => true),
      pendingApproval: sum((m) => m.status === "PENDING_APPROVAL"),
      suspended: sum((m) => m.status === "SUSPENDED"),
      mfaEnabled: f.mfaEnabled,
      pendingInvitations: f.pendingInvitations,
      activeLast7Days: f.activeLast7Days,
      byRole: (Object.keys(ROLE_LABELS) as StaffRole[]).map((role) => ({
        role,
        label: ROLE_LABELS[role],
        count: sum((m) => m.role === role && m.status === "ACTIVE"),
      })),
      daily: daily.map((d) => ({ day: d.key, signIns: d.count, people: d.people })),
    };
  }

  private async databases(days: string[]) {
    const f = await this.query.databases(dayStart(days[0]));
    const health = (h: string) => f.serversByHealth.find((r) => r.health === h)?.count ?? 0;
    const backups = fill(days, f.backups, ["done", "failed"]);
    return {
      servers: f.serversByHealth.reduce((n, r) => n + r.count, 0),
      byHealth: HEALTH_ORDER.map((h) => ({ health: h, label: HEALTH_LABELS[h], count: health(h) })),
      capacity: f.capacity,
      assigned: f.assigned,
      backups: backups.map((b) => ({ day: b.key, done: b.done, failed: b.failed })),
    };
  }
}
