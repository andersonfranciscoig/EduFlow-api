import { Prisma, type PrismaClient } from ".prisma/tenant-client";

export interface JustificationRow {
  id: string;
  occurrenceId: string;
  employeeId: string;
  teacherName: string;
  reason: string;
  proof: { name: string; mimeType: string; size: number; storageKey: string } | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decisionNote: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  // a ocorrência (para a lista do RH)
  day: string;
  kind: string;
  minutesLate: number | null;
  scope: string;
  subjectName: string | null;
  groupName: string | null;
  startsAt: string | null;
  occurrenceStatus: string;
  source: string;
}
type Raw = {
  id: string;
  occurrence_id: string;
  employee_id: string;
  teacher_name: string;
  reason: string;
  proof_name: string | null;
  proof_mime_type: string | null;
  proof_size: number | null;
  proof_storage_key: string | null;
  status: string;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  day: string;
  kind: string;
  minutes_late: number | null;
  scope: string;
  subject_name: string | null;
  group_name: string | null;
  starts_at: string | null;
  occurrence_status: string;
  source: string;
};
const row = (r: Raw): JustificationRow => ({
  id: r.id,
  occurrenceId: r.occurrence_id,
  employeeId: r.employee_id,
  teacherName: r.teacher_name,
  reason: r.reason,
  proof: r.proof_storage_key && r.proof_name ? { name: r.proof_name, mimeType: r.proof_mime_type ?? "application/octet-stream", size: r.proof_size ?? 0, storageKey: r.proof_storage_key } : null,
  status: r.status as JustificationRow["status"],
  decisionNote: r.decision_note,
  decidedByName: r.decided_by,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
  day: r.day,
  kind: r.kind,
  minutesLate: r.minutes_late,
  scope: r.scope,
  subjectName: r.subject_name,
  groupName: r.group_name,
  startsAt: r.starts_at,
  occurrenceStatus: r.occurrence_status,
  source: r.source,
});
const SELECT = Prisma.sql`
  SELECT j.id, j.occurrence_id, j.employee_id, e.full_name AS teacher_name, j.reason, j.proof_name, j.proof_mime_type, j.proof_size, j.proof_storage_key,
         j.status, j.decision_note, u.full_name AS decided_by, j.decided_at, j.created_at,
         to_char(o.day, 'YYYY-MM-DD') AS day, o.kind, o.minutes_late, o.scope, o.subject_name, o.group_name, to_char(o.starts_at, 'HH24:MI') AS starts_at,
         o.status AS occurrence_status, o.source
    FROM occurrence_justifications j JOIN teacher_occurrences o ON o.id = j.occurrence_id JOIN employees e ON e.id = j.employee_id
    LEFT JOIN school_users u ON u.id = j.decided_by_id`;

/** Justificações das faltas/atrasos dos professores. */
export class PrismaJustificationsRepository {
  constructor(private readonly db: PrismaClient) {}

  async employeeOfUser(userId: string) {
    return this.db.employee.findUnique({ where: { userId }, select: { id: true, fullName: true } });
  }

  async find(id: string) {
    const r = await this.db.$queryRaw<Raw[]>`${SELECT} WHERE j.id = ${id}::uuid`;
    return r[0] ? row(r[0]) : null;
  }

  async forOccurrences(occurrenceIds: string[]) {
    if (!occurrenceIds.length) return [];
    const r = await this.db.$queryRaw<Raw[]>`${SELECT} WHERE j.occurrence_id = ANY(${occurrenceIds}::uuid[]) ORDER BY j.created_at DESC`;
    return r.map(row);
  }

  async list(f: { status?: string; page: number; pageSize: number }) {
    const where = f.status ? Prisma.sql`j.status = ${f.status}` : Prisma.sql`TRUE`;
    const [t, rows] = await Promise.all([
      this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM occurrence_justifications j WHERE ${where}`,
      this.db.$queryRaw<Raw[]>`${SELECT} WHERE ${where} ORDER BY (j.status = 'PENDING') DESC, j.created_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    ]);
    return { total: t[0]?.n ?? 0, items: rows.map(row) };
  }

  async counts() {
    const [r] = await this.db.$queryRaw<{ pending: number; approved: number; rejected: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending, count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
             count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected FROM occurrence_justifications`;
    return r ?? { pending: 0, approved: 0, rejected: 0 };
  }

  /** Cria (false = já há uma pendente nessa ocorrência). */
  async create(i: { id: string; occurrenceId: string; employeeId: string; reason: string; proof: { name: string; mimeType: string; size: number; sha256: string; storageKey: string } | null; actorId: string; now: Date }) {
    const n = await this.db.$executeRaw`
      INSERT INTO occurrence_justifications (id, occurrence_id, employee_id, reason, proof_name, proof_mime_type, proof_size, proof_sha256, proof_storage_key, status, created_by_id, created_at)
      VALUES (${i.id}::uuid, ${i.occurrenceId}::uuid, ${i.employeeId}::uuid, ${i.reason}, ${i.proof?.name ?? null}, ${i.proof?.mimeType ?? null}, ${i.proof?.size ?? null}, ${i.proof?.sha256 ?? null}, ${i.proof?.storageKey ?? null}, 'PENDING', ${i.actorId}::uuid, ${i.now})
      ON CONFLICT DO NOTHING`;
    return n === 1;
  }

  /** Decide uma pendente (false = já não estava pendente). */
  async decide(id: string, status: "APPROVED" | "REJECTED", note: string | null, actorId: string, now: Date) {
    const n = await this.db.$executeRaw`
      UPDATE occurrence_justifications SET status = ${status}, decision_note = ${note}, decided_by_id = ${actorId}::uuid, decided_at = ${now}
       WHERE id = ${id}::uuid AND status = 'PENDING'`;
    return n === 1;
  }

  /** O professor retira a justificação ainda pendente (devolve a chave do comprovativo, para o apagar). */
  async withdraw(id: string, employeeId: string) {
    const r = await this.db.$queryRaw<{ proof_storage_key: string | null }[]>`
      DELETE FROM occurrence_justifications WHERE id = ${id}::uuid AND employee_id = ${employeeId}::uuid AND status = 'PENDING' RETURNING proof_storage_key`;
    return r[0] ? { key: r[0].proof_storage_key } : null;
  }
}
