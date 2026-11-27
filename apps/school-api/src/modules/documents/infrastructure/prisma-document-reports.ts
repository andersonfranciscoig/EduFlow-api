import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Audience, RequestStatus } from "../domain/documents";

type Db = PrismaClient | Prisma.TransactionClient;
const OPEN = Prisma.sql`('PENDING','IN_REVIEW','AWAITING_PAYMENT','PROCESSING','READY_PICKUP','READY_DOWNLOAD')`;

/** Os números do relatório dos documentos (BD do colégio), por público e período (data do pedido). */
export class PrismaDocumentReports {
  constructor(private readonly db: Db) {}
  static for(db: PrismaClient) {
    return new PrismaDocumentReports(db);
  }
  private where(a: Audience, from: string, to: string) {
    return Prisma.sql`r.audience = ${a} AND r.created_at >= ${from}::date AND r.created_at < (${to}::date + 1)`;
  }

  async totals(a: Audience, from: string, to: string, today: string) {
    const [r] = await this.db.$queryRaw<{ total: number; open: number; completed: number; rejected: number; cancelled: number; overdue: number; avgDays: number | null; onTime: number; withAttachments: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE r.status IN ${OPEN})::int AS open,
             count(*) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE r.status = 'REJECTED')::int AS rejected,
             count(*) FILTER (WHERE r.status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE r.status IN ('PENDING','IN_REVIEW','AWAITING_PAYMENT','PROCESSING') AND r.due_on < ${today}::date)::int AS overdue,
             round((avg(extract(epoch FROM r.completed_at - r.created_at) / 86400) FILTER (WHERE r.completed_at IS NOT NULL))::numeric, 1)::float AS "avgDays",
             count(*) FILTER (WHERE r.completed_at IS NOT NULL AND (r.completed_at AT TIME ZONE 'Africa/Luanda')::date <= r.due_on)::int AS "onTime",
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM document_request_files f WHERE f.request_id = r.id))::int AS "withAttachments"
        FROM document_requests r WHERE ${this.where(a, from, to)}`;
    return r;
  }
  byStatus(a: Audience, from: string, to: string) {
    return this.db.$queryRaw<{ status: RequestStatus; n: number }[]>`SELECT r.status, count(*)::int AS n FROM document_requests r WHERE ${this.where(a, from, to)} GROUP BY r.status`;
  }
  byType(a: Audience, from: string, to: string) {
    return this.db.$queryRaw<{ name: string; total: number; open: number; completed: number; rejected: number; avgDays: number | null }[]>`
      SELECT r.type_name AS name, count(*)::int AS total,
             count(*) FILTER (WHERE r.status IN ${OPEN})::int AS open,
             count(*) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE r.status = 'REJECTED')::int AS rejected,
             round((avg(extract(epoch FROM r.completed_at - r.created_at) / 86400) FILTER (WHERE r.completed_at IS NOT NULL))::numeric, 1)::float AS "avgDays"
        FROM document_requests r WHERE ${this.where(a, from, to)}
       GROUP BY r.type_name ORDER BY count(*) DESC, r.type_name LIMIT 30`;
  }
  byMonth(a: Audience, from: string, to: string) {
    return this.db.$queryRaw<{ month: string; total: number; completed: number }[]>`
      SELECT to_char(r.created_at AT TIME ZONE 'Africa/Luanda', 'YYYY-MM') AS month, count(*)::int AS total, count(*) FILTER (WHERE r.status = 'COMPLETED')::int AS completed
        FROM document_requests r WHERE ${this.where(a, from, to)} GROUP BY 1 ORDER BY 1`;
  }
  /** As entregas físicas no período (pela data da entrega), por quem recebeu. */
  deliveries(a: Audience, from: string, to: string) {
    return this.db.$queryRaw<{ relationship: string; n: number }[]>`
      SELECT d.relationship, count(*)::int AS n FROM document_deliveries d JOIN document_requests r ON r.id = d.request_id
       WHERE r.audience = ${a} AND d.delivered_at >= ${from}::date AND d.delivered_at < (${to}::date + 1) GROUP BY d.relationship`;
  }
  /** As taxas dos pedidos do período, pelo estado da cobrança. */
  fees(from: string, to: string) {
    return this.db.$queryRaw<{ status: string; n: number; amount: number }[]>`
      SELECT c.status, count(*)::int AS n, coalesce(sum(c.amount), 0)::int AS amount
        FROM document_requests r JOIN charges c ON c.id = r.charge_id
       WHERE ${this.where("STUDENT", from, to)} GROUP BY c.status`;
  }
  /** Os cartões emitidos e anulados no período. */
  async cards(from: string, to: string) {
    const [r] = await this.db.$queryRaw<{ issued: number; secondCopies: number; fromRequests: number; revoked: number }[]>`
      SELECT count(*) FILTER (WHERE created_at >= ${from}::date AND created_at < (${to}::date + 1))::int AS issued,
             count(*) FILTER (WHERE version > 1 AND created_at >= ${from}::date AND created_at < (${to}::date + 1))::int AS "secondCopies",
             count(*) FILTER (WHERE request_id IS NOT NULL AND created_at >= ${from}::date AND created_at < (${to}::date + 1))::int AS "fromRequests",
             count(*) FILTER (WHERE status = 'REVOKED' AND ended_at >= ${from}::date AND ended_at < (${to}::date + 1))::int AS revoked
        FROM student_cards`;
    return r;
  }
}
