import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";

export interface PendingRow {
  id: string;
  lessonId: string | null;
  teacherId: string | null;
  teacherName: string | null;
  groupName: string;
  subjectName: string;
  day: string;
  startsAt: string;
  endsAt: string;
  status: string;
  occurrenceId: string | null;
  reason: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}
type Raw = { id: string; lesson_id: string | null; teacher_id: string | null; teacher_name: string | null; group_name: string; subject_name: string; day: string; starts_at: string; ends_at: string; status: string; occurrence_id: string | null; reason: string | null; decided_by: string | null; decided_at: Date | null; created_at: Date };
const row = (r: Raw): PendingRow => ({
  id: r.id,
  lessonId: r.lesson_id,
  teacherId: r.teacher_id,
  teacherName: r.teacher_name,
  groupName: r.group_name,
  subjectName: r.subject_name,
  day: r.day,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  status: r.status,
  occurrenceId: r.occurrence_id,
  reason: r.reason,
  decidedByName: r.decided_by,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
});
const SELECT = Prisma.sql`
  SELECT p.id, p.lesson_id, p.teacher_id, e.full_name AS teacher_name, p.group_name, p.subject_name, to_char(p.day, 'YYYY-MM-DD') AS day,
         to_char(p.starts_at, 'HH24:MI') AS starts_at, to_char(p.ends_at, 'HH24:MI') AS ends_at, p.status, p.occurrence_id, p.reason,
         u.full_name AS decided_by, p.decided_at, p.created_at
    FROM lesson_pendings p LEFT JOIN employees e ON e.id = p.teacher_id LEFT JOIN school_users u ON u.id = p.decided_by_id`;

export interface SubstitutionRow {
  id: string;
  lessonId: string;
  day: string;
  startsAt: string;
  endsAt: string;
  groupName: string;
  subjectName: string;
  substituteId: string;
  substituteName: string;
  originalId: string | null;
  originalName: string | null;
  reason: string | null;
  submitted: boolean;
  createdAt: Date;
}

/** Aulas pendentes (decisões do RH) e substituições. */
export class PrismaPendingsRepository {
  constructor(private readonly db: PrismaClient) {}

  async list(f: { status?: string; teacherId?: string; page: number; pageSize: number }) {
    const c: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.status) c.push(Prisma.sql`p.status = ${f.status}`);
    if (f.teacherId) c.push(Prisma.sql`p.teacher_id = ${f.teacherId}::uuid`);
    const where = Prisma.join(c, " AND ");
    const [t, rows] = await Promise.all([
      this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM lesson_pendings p WHERE ${where}`,
      this.db.$queryRaw<Raw[]>`${SELECT} WHERE ${where} ORDER BY (p.status = 'OPEN') DESC, p.day DESC, p.starts_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    ]);
    return { total: t[0]?.n ?? 0, items: rows.map(row) };
  }

  async counts() {
    const [r] = await this.db.$queryRaw<{ open: number; late: number; fault: number; dismissed: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'OPEN')::int AS open, count(*) FILTER (WHERE status = 'SUBMITTED_LATE')::int AS late,
             count(*) FILTER (WHERE status = 'FAULT')::int AS fault, count(*) FILTER (WHERE status = 'DISMISSED')::int AS dismissed FROM lesson_pendings`;
    return r ?? { open: 0, late: 0, fault: 0, dismissed: 0 };
  }

  async find(id: string) {
    const r = await this.db.$queryRaw<Raw[]>`${SELECT} WHERE p.id = ${id}::uuid`;
    return r[0] ? row(r[0]) : null;
  }

  /** Decide uma pendência ainda aberta (false = já não estava aberta). */
  async decide(id: string, status: "FAULT" | "DISMISSED", occurrenceId: string | null, reason: string | null, actorId: string, now: Date) {
    const n = await this.db.$executeRaw`
      UPDATE lesson_pendings SET status = ${status}, occurrence_id = ${occurrenceId}::uuid, reason = ${reason}, decided_by_id = ${actorId}::uuid, decided_at = ${now}
       WHERE id = ${id}::uuid AND status = 'OPEN'`;
    return n === 1;
  }

  /** O professor submeteu as presenças depois do prazo: a pendência fica resolvida (fora do prazo). */
  async resolveLate(groupId: string, day: string, startsAt: string, now: Date) {
    await this.db.$executeRaw`UPDATE lesson_pendings SET status = 'SUBMITTED_LATE', decided_at = ${now} WHERE group_id = ${groupId}::uuid AND day = ${day}::date AND starts_at = ${startsAt}::time AND status = 'OPEN'`;
  }

  // ------------------------------------------------------------ substituições

  async substitutionOn(lessonId: string, day: string) {
    const r = await this.db.$queryRaw<{ id: string; substitute_id: string }[]>`SELECT id, substitute_id FROM lesson_substitutions WHERE lesson_id = ${lessonId}::uuid AND day = ${day}::date`;
    return r[0] ? { id: r[0].id, substituteId: r[0].substitute_id } : null;
  }

  async substitutions(from: string): Promise<SubstitutionRow[]> {
    const r = await this.db.$queryRaw<
      { id: string; lesson_id: string; day: string; starts_at: string; ends_at: string; group_name: string; subject_name: string; substitute_id: string; substitute_name: string; original_id: string | null; original_name: string | null; reason: string | null; submitted: boolean; created_at: Date }[]
    >`
      SELECT s.id, s.lesson_id, to_char(s.day, 'YYYY-MM-DD') AS day, to_char(p.starts_at, 'HH24:MI') AS starts_at, to_char(p.ends_at, 'HH24:MI') AS ends_at,
             g.name AS group_name, sub.name AS subject_name, s.substitute_id, es.full_name AS substitute_name, s.original_teacher_id AS original_id, eo.full_name AS original_name,
             s.reason, EXISTS (SELECT 1 FROM lesson_sessions ss WHERE ss.group_id = l.group_id AND ss.day = s.day AND ss.starts_at = date_trunc('minute', p.starts_at::interval)::time) AS submitted, s.created_at
        FROM lesson_substitutions s JOIN lessons l ON l.id = s.lesson_id JOIN school_periods p ON p.id = l.period_id JOIN class_groups g ON g.id = l.group_id
        JOIN subjects sub ON sub.id = l.subject_id JOIN employees es ON es.id = s.substitute_id LEFT JOIN employees eo ON eo.id = s.original_teacher_id
       WHERE s.day >= ${from}::date ORDER BY s.day, p.starts_at`;
    return r.map((x) => ({
      id: x.id,
      lessonId: x.lesson_id,
      day: x.day,
      startsAt: x.starts_at,
      endsAt: x.ends_at,
      groupName: x.group_name,
      subjectName: x.subject_name,
      substituteId: x.substitute_id,
      substituteName: x.substitute_name,
      originalId: x.original_id,
      originalName: x.original_name,
      reason: x.reason,
      submitted: x.submitted,
      createdAt: x.created_at,
    }));
  }

  async substitution(id: string) {
    return (await this.substitutions("1900-01-01")).find((s) => s.id === id) ?? null;
  }

  /**
   * Quem pode substituir a aula: os professores (com aulas no horário de anos não encerrados) e se estão
   * ocupados a essa hora nesse dia (aula própria não substituída, ou outra substituição).
   */
  async candidates(lessonId: string, day: string) {
    return this.db.$queryRaw<{ id: string; full_name: string; has_portal: boolean; busy: string | null }[]>`
      WITH target AS (
        SELECT l.academic_year_id, l.weekday, l.teacher_id, p.starts_at, p.ends_at FROM lessons l JOIN school_periods p ON p.id = l.period_id WHERE l.id = ${lessonId}::uuid
      )
      SELECT e.id, e.full_name, (e.user_id IS NOT NULL) AS has_portal,
             (SELECT g.name || ' · ' || to_char(p2.starts_at, 'HH24:MI')
                FROM lessons l2 JOIN school_periods p2 ON p2.id = l2.period_id JOIN class_groups g ON g.id = l2.group_id, target t
               WHERE l2.teacher_id = e.id AND l2.academic_year_id = t.academic_year_id AND l2.weekday = t.weekday
                 AND p2.starts_at < t.ends_at AND p2.ends_at > t.starts_at
                 AND NOT EXISTS (SELECT 1 FROM lesson_substitutions x WHERE x.lesson_id = l2.id AND x.day = ${day}::date)
               UNION ALL
              SELECT g.name || ' · ' || to_char(p3.starts_at, 'HH24:MI') || ' (substituição)'
                FROM lesson_substitutions s3 JOIN lessons l3 ON l3.id = s3.lesson_id JOIN school_periods p3 ON p3.id = l3.period_id JOIN class_groups g ON g.id = l3.group_id, target t
               WHERE s3.substitute_id = e.id AND s3.day = ${day}::date AND s3.lesson_id <> ${lessonId}::uuid AND p3.starts_at < t.ends_at AND p3.ends_at > t.starts_at
               LIMIT 1) AS busy
        FROM employees e, target t
       WHERE e.id <> coalesce(t.teacher_id, '00000000-0000-0000-0000-000000000000'::uuid)
         AND e.status = 'ACTIVE'
         -- professores com aulas, ou qualquer pessoa da equipa com conta no portal (pode registar as presenças)
         AND (e.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM lessons lx JOIN academic_years y ON y.id = lx.academic_year_id WHERE lx.teacher_id = e.id AND y.status <> 'CLOSED'))
       ORDER BY e.full_name`;
  }

  /** Cria (false = já há uma substituição nessa aula e dia). */
  async createSubstitution(i: { id: string; lessonId: string; day: string; substituteId: string; originalId: string | null; reason: string | null; actorId: string; now: Date }) {
    const n = await this.db.$executeRaw`
      INSERT INTO lesson_substitutions (id, lesson_id, day, substitute_id, original_teacher_id, reason, created_by_id, created_at)
      VALUES (${i.id}::uuid, ${i.lessonId}::uuid, ${i.day}::date, ${i.substituteId}::uuid, ${i.originalId}::uuid, ${i.reason}, ${i.actorId}::uuid, ${i.now})
      ON CONFLICT (lesson_id, day) DO NOTHING`;
    return n === 1;
  }

  async removeSubstitution(id: string) {
    await this.db.$executeRaw`DELETE FROM lesson_substitutions WHERE id = ${id}::uuid`;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
