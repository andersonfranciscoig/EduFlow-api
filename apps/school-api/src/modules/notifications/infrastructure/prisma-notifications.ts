import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";

export interface InboxRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}
export interface DeliveryRow {
  id: string;
  audience: string;
  recipientName: string | null;
  kind: string;
  title: string;
  channel: string;
  destination: string | null;
  status: string;
  error: string | null;
  createdAt: Date;
}

/** Caixa da equipa, preferências, tipos do colégio e histórico de envios. */
export class PrismaNotificationsRepository {
  constructor(private readonly db: PrismaClient) {}

  async inbox(userId: string, limit: number): Promise<InboxRow[]> {
    const r = await this.db.$queryRaw<{ id: string; kind: string; title: string; body: string | null; link: string | null; read_at: Date | null; created_at: Date }[]>`
      SELECT id, kind, title, body, link, read_at, created_at FROM staff_notifications WHERE user_id = ${userId}::uuid ORDER BY created_at DESC LIMIT ${limit}`;
    return r.map((x) => ({ id: x.id, kind: x.kind, title: x.title, body: x.body, link: x.link, readAt: x.read_at, createdAt: x.created_at }));
  }

  async unread(userId: string) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM staff_notifications WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
    return r?.n ?? 0;
  }

  async markRead(userId: string, ids: string[] | null, now: Date) {
    return ids
      ? this.db.$executeRaw`UPDATE staff_notifications SET read_at = ${now} WHERE user_id = ${userId}::uuid AND read_at IS NULL AND id = ANY(${ids}::uuid[])`
      : this.db.$executeRaw`UPDATE staff_notifications SET read_at = ${now} WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
  }

  async preferences(userId: string) {
    const r = await this.db.$queryRaw<{ kind: string; email: boolean }[]>`SELECT kind, email FROM notification_preferences WHERE user_id = ${userId}::uuid`;
    return new Map(r.map((x) => [x.kind, x.email]));
  }

  async setPreference(userId: string, kind: string, email: boolean, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO notification_preferences (user_id, kind, email, updated_at) VALUES (${userId}::uuid, ${kind}, ${email}, ${now})
      ON CONFLICT (user_id, kind) DO UPDATE SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at`;
  }

  async types() {
    const r = await this.db.$queryRaw<{ kind: string; enabled: boolean; email: boolean; updated_at: Date; by: string | null }[]>`
      SELECT t.kind, t.enabled, t.email, t.updated_at, u.full_name AS by FROM notification_types t LEFT JOIN school_users u ON u.id = t.updated_by_id`;
    return new Map(r.map((x) => [x.kind, { enabled: x.enabled, email: x.email, updatedAt: x.updated_at, updatedBy: x.by }]));
  }

  async setType(kind: string, enabled: boolean, email: boolean, actorId: string | null, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO notification_types (kind, enabled, email, updated_by_id, updated_at) VALUES (${kind}, ${enabled}, ${email}, ${actorId}::uuid, ${now})
      ON CONFLICT (kind) DO UPDATE SET enabled = EXCLUDED.enabled, email = EXCLUDED.email, updated_by_id = EXCLUDED.updated_by_id, updated_at = EXCLUDED.updated_at`;
  }

  async deliveries(f: { kind?: string; status?: string; channel?: string; audience?: string; page: number; pageSize: number }) {
    const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.kind) c.push(Prisma.sql`kind = ${f.kind}`);
    if (f.status) c.push(Prisma.sql`status = ${f.status}`);
    if (f.channel) c.push(Prisma.sql`channel = ${f.channel}`);
    if (f.audience) c.push(Prisma.sql`audience = ${f.audience}`);
    const where = Prisma.join(c, " AND ");
    const [total, rows] = await Promise.all([
      this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_deliveries WHERE ${where}`,
      this.db.$queryRaw<{ id: string; audience: string; recipient_name: string | null; kind: string; title: string; channel: string; destination: string | null; status: string; error: string | null; created_at: Date }[]>`
        SELECT id, audience, recipient_name, kind, title, channel, destination, status, error, created_at FROM notification_deliveries WHERE ${where}
         ORDER BY created_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    ]);
    return {
      total: total[0]?.n ?? 0,
      items: rows.map((x): DeliveryRow => ({ id: x.id, audience: x.audience, recipientName: x.recipient_name, kind: x.kind, title: x.title, channel: x.channel, destination: x.destination, status: x.status, error: x.error, createdAt: x.created_at })),
    };
  }

  async deliveryCounts() {
    const [r] = await this.db.$queryRaw<{ sent: number; failed: number; skipped: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'SENT')::int AS sent, count(*) FILTER (WHERE status = 'FAILED')::int AS failed, count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped
        FROM notification_deliveries WHERE created_at > now() - interval '30 days'`;
    return r ?? { sent: 0, failed: 0, skipped: 0 };
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
