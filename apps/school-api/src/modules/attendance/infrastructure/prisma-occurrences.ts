import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { HistoryRow, NewOccurrence, OccurrenceFilter, OccurrenceRow, OccurrencesRepository, PlanLesson, TeacherRow } from "../application/occurrence-ports";
import type { OccurrenceKind, OccurrenceScope, OccurrenceSource, OccurrenceStatus } from "../domain/occurrences";

type Raw = {
  id: string;
  employee_id: string;
  teacher_name: string;
  day: string;
  scope: string;
  lesson_id: string | null;
  group_name: string | null;
  subject_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
  kind: string;
  minutes_late: number | null;
  source: string;
  status: string;
  note: string | null;
  justification: string | null;
  created_at: Date;
  created_by_name: string | null;
  updated_at: Date;
};
const row = (r: Raw): OccurrenceRow => ({
  id: r.id,
  employeeId: r.employee_id,
  teacherName: r.teacher_name,
  day: r.day,
  scope: r.scope as OccurrenceScope,
  lessonId: r.lesson_id,
  groupName: r.group_name,
  subjectName: r.subject_name,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  kind: r.kind as OccurrenceKind,
  minutesLate: r.minutes_late,
  source: r.source as OccurrenceSource,
  status: r.status as OccurrenceStatus,
  note: r.note,
  justification: r.justification,
  createdAt: r.created_at,
  createdByName: r.created_by_name,
  updatedAt: r.updated_at,
});
const SELECT = Prisma.sql`
  SELECT o.id, o.employee_id, e.full_name AS teacher_name, to_char(o.day, 'YYYY-MM-DD') AS day, o.scope, o.lesson_id, o.group_name, o.subject_name,
         to_char(o.starts_at, 'HH24:MI') AS starts_at, to_char(o.ends_at, 'HH24:MI') AS ends_at, o.kind, o.minutes_late, o.source, o.status,
         o.note, o.justification, o.created_at, u.full_name AS created_by_name, o.updated_at
    FROM teacher_occurrences o JOIN employees e ON e.id = o.employee_id LEFT JOIN school_users u ON u.id = o.created_by_id`;

const unique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError ? e.code === "P2010" && String(e.meta?.code) === "23505" : String((e as { message?: string })?.message ?? "").includes("23505");

export class PrismaOccurrencesRepository implements OccurrencesRepository {
  constructor(private readonly db: PrismaClient) {}

  async teacher(employeeId: string) {
    const e = await this.db.employee.findUnique({ where: { id: employeeId }, select: { id: true, fullName: true, number: true } });
    return e ?? null;
  }

  async teachers(): Promise<TeacherRow[]> {
    const rows = await this.db.$queryRaw<{ id: string; full_name: string; number: number | null; weekly: number; open: number; justified: number }[]>`
      SELECT e.id, e.full_name, e.number,
             (SELECT count(*)::int FROM lessons l JOIN academic_years y ON y.id = l.academic_year_id WHERE l.teacher_id = e.id AND y.status <> 'CLOSED') AS weekly,
             (SELECT count(*)::int FROM teacher_occurrences o WHERE o.employee_id = e.id AND o.status = 'REGISTADA') AS open,
             (SELECT count(*)::int FROM teacher_occurrences o WHERE o.employee_id = e.id AND o.status = 'JUSTIFICADA') AS justified
        FROM employees e
       WHERE EXISTS (SELECT 1 FROM lessons l JOIN academic_years y ON y.id = l.academic_year_id WHERE l.teacher_id = e.id AND y.status <> 'CLOSED')
          OR EXISTS (SELECT 1 FROM teacher_occurrences o WHERE o.employee_id = e.id)
       ORDER BY e.full_name`;
    return rows.map((r) => ({ id: r.id, fullName: r.full_name, number: r.number, weeklyLessons: r.weekly, open: r.open, justified: r.justified }));
  }

  async yearOn(day: string) {
    const rows = await this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM academic_years WHERE ${day}::date BETWEEN starts_on AND ends_on ORDER BY (status = 'ACTIVE') DESC, starts_on LIMIT 1`;
    return rows[0] ?? null;
  }

  async closureOn(yearId: string, day: string) {
    const rows = await this.db.$queryRaw<{ kind: string; reason: string }[]>`
      SELECT kind, reason FROM school_closures WHERE academic_year_id = ${yearId}::uuid AND ${day}::date BETWEEN starts_on AND ends_on LIMIT 1`;
    const r = rows[0];
    return r ? { kindLabel: { FERIADO: "Feriado", PAUSA: "Pausa letiva", OUTRO: "Sem aulas" }[r.kind] ?? "Sem aulas", reason: r.reason } : null;
  }

  async lessonsOn(employeeId: string, yearId: string, day: string): Promise<PlanLesson[]> {
    return this.db.$queryRaw<PlanLesson[]>`
      SELECT l.id, to_char(p.starts_at, 'HH24:MI') AS "startsAt", to_char(p.ends_at, 'HH24:MI') AS "endsAt", g.name AS "groupName", s.name AS "subjectName"
        FROM lessons l JOIN school_periods p ON p.id = l.period_id JOIN class_groups g ON g.id = l.group_id JOIN subjects s ON s.id = l.subject_id
       WHERE l.teacher_id = ${employeeId}::uuid AND l.academic_year_id = ${yearId}::uuid AND l.weekday = extract(isodow FROM ${day}::date)::int
       ORDER BY p.starts_at`;
  }

  async onDay(employeeId: string, day: string) {
    const rows = await this.db.$queryRaw<Raw[]>`${SELECT} WHERE o.employee_id = ${employeeId}::uuid AND o.day = ${day}::date ORDER BY o.starts_at NULLS FIRST, o.created_at`;
    return rows.map(row);
  }

  async create(items: NewOccurrence[], actorId: string | null, now: Date) {
    try {
      await this.db.$transaction(
        items.map(
          (o) => this.db.$executeRaw`
            INSERT INTO teacher_occurrences (id, employee_id, day, scope, lesson_id, group_name, subject_name, starts_at, ends_at, kind, minutes_late, source, status, note, created_by_id, created_at, updated_by_id, updated_at)
            VALUES (${o.id}::uuid, ${o.employeeId}::uuid, ${o.day}::date, ${o.scope}, ${o.lesson?.id ?? null}::uuid, ${o.lesson?.groupName ?? null}, ${o.lesson?.subjectName ?? null},
                    ${o.lesson?.startsAt ?? null}::time, ${o.lesson?.endsAt ?? null}::time, ${o.kind}, ${o.minutesLate}, ${o.source}, 'REGISTADA', ${o.note}, ${actorId}::uuid, ${now}, ${actorId}::uuid, ${now})`,
        ),
      );
      return true;
    } catch (e) {
      if (unique(e)) return false;
      throw e;
    }
  }

  async find(id: string) {
    const rows = await this.db.$queryRaw<Raw[]>`${SELECT} WHERE o.id = ${id}::uuid`;
    return rows[0] ? row(rows[0]) : null;
  }

  async list(f: OccurrenceFilter) {
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.employeeId) conds.push(Prisma.sql`o.employee_id = ${f.employeeId}::uuid`);
    if (f.status) conds.push(Prisma.sql`o.status = ${f.status}`);
    if (f.source) conds.push(Prisma.sql`o.source = ${f.source}`);
    if (f.from) conds.push(Prisma.sql`o.day >= ${f.from}::date`);
    if (f.to) conds.push(Prisma.sql`o.day <= ${f.to}::date`);
    const where = Prisma.join(conds, " AND ");
    const [total, rows] = await Promise.all([
      this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM teacher_occurrences o WHERE ${where}`,
      this.db.$queryRaw<Raw[]>`${SELECT} WHERE ${where} ORDER BY o.day DESC, o.starts_at NULLS FIRST, o.created_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
    ]);
    return { total: total[0]?.n ?? 0, items: rows.map(row) };
  }

  async counts() {
    const r = await this.db.$queryRaw<{ open: number; justified: number; cancelled: number; automatic: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'REGISTADA')::int AS open, count(*) FILTER (WHERE status = 'JUSTIFICADA')::int AS justified,
             count(*) FILTER (WHERE status = 'ANULADA')::int AS cancelled, count(*) FILTER (WHERE source = 'AUTOMATIC' AND status <> 'ANULADA')::int AS automatic
        FROM teacher_occurrences`;
    return r[0] ?? { open: 0, justified: 0, cancelled: 0, automatic: 0 };
  }

  async update(id: string, p: { kind: OccurrenceKind; minutesLate: number | null; status: OccurrenceStatus; justification: string | null }, actorId: string | null, now: Date) {
    try {
      await this.db.$executeRaw`
        UPDATE teacher_occurrences SET kind = ${p.kind}, minutes_late = ${p.minutesLate}, status = ${p.status}, justification = ${p.justification},
               updated_by_id = ${actorId}::uuid, updated_at = ${now} WHERE id = ${id}::uuid`;
      return true;
    } catch (e) {
      if (unique(e)) return false;
      throw e;
    }
  }

  async mirrorDaily(employeeId: string, day: string, rec: { status: string; minutesLate: number | null; note: string | null }, actorId: string | null, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO employee_attendance (id, employee_id, day, status, minutes_late, note, recorded_by_id, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${employeeId}::uuid, ${day}::date, ${rec.status}, ${rec.minutesLate}, ${rec.note}, ${actorId}::uuid, ${now}, ${now})
      ON CONFLICT (employee_id, day) DO UPDATE SET status = EXCLUDED.status, minutes_late = EXCLUDED.minutes_late, note = EXCLUDED.note,
             recorded_by_id = EXCLUDED.recorded_by_id, updated_at = EXCLUDED.updated_at,
             -- um comprovativo antigo não fica numa presença
             proof_name = CASE WHEN EXCLUDED.status = 'PRESENTE' THEN NULL ELSE employee_attendance.proof_name END,
             proof_mime_type = CASE WHEN EXCLUDED.status = 'PRESENTE' THEN NULL ELSE employee_attendance.proof_mime_type END,
             proof_size = CASE WHEN EXCLUDED.status = 'PRESENTE' THEN NULL ELSE employee_attendance.proof_size END,
             proof_sha256 = CASE WHEN EXCLUDED.status = 'PRESENTE' THEN NULL ELSE employee_attendance.proof_sha256 END,
             proof_storage_key = CASE WHEN EXCLUDED.status = 'PRESENTE' THEN NULL ELSE employee_attendance.proof_storage_key END,
             proof_uploaded_at = CASE WHEN EXCLUDED.status = 'PRESENTE' THEN NULL ELSE employee_attendance.proof_uploaded_at END`;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  async history(id: string): Promise<HistoryRow[]> {
    const rows = await this.db.$queryRaw<{ occurred_at: Date; type: string; by: string | null; details: HistoryRow["details"] }[]>`
      SELECT a.occurred_at, a.type, u.full_name AS by, a.details FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id
       WHERE a.subject_id = ${id}::uuid AND a.type LIKE 'TEACHER_OCCURRENCE_%' ORDER BY a.occurred_at`;
    return rows.map((r) => ({ at: r.occurred_at, type: r.type, actorName: r.by, details: r.details }));
  }
}
