import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Counts, GroupRow, LessonRow, PresenceRepository, RosterRow, SessionMarkRow, SessionRow, StudentSummaryRow, TeacherLessonRow } from "../application/presence-ports";
import type { Mark, PresenceStatus } from "../domain/presence";

type CountRaw = { present: number; absent: number; late_n: number; justified: number; total: number };
const counts = (r: CountRaw): Counts => ({ present: r.present ?? 0, absent: r.absent ?? 0, late: r.late_n ?? 0, justified: r.justified ?? 0, total: r.total ?? 0 });
/** contagens das presenças de uma aula (subconsulta por linha) */
const COUNTS = (alias: string) =>
  Prisma.raw(`
  (SELECT count(*) FILTER (WHERE a.status = 'PRESENTE') FROM student_attendance a WHERE a.session_id = ${alias}.id)::int AS present,
  (SELECT count(*) FILTER (WHERE a.status = 'AUSENTE') FROM student_attendance a WHERE a.session_id = ${alias}.id)::int AS absent,
  (SELECT count(*) FILTER (WHERE a.status = 'ATRASADO') FROM student_attendance a WHERE a.session_id = ${alias}.id)::int AS late_n,
  (SELECT count(*) FILTER (WHERE a.status = 'FALTA_JUSTIFICADA') FROM student_attendance a WHERE a.session_id = ${alias}.id)::int AS justified,
  (SELECT count(*) FROM student_attendance a WHERE a.session_id = ${alias}.id)::int AS total`);

type SessionRaw = CountRaw & {
  id: string;
  lesson_id: string | null;
  academic_year_id: string;
  group_id: string;
  group_name: string;
  subject_name: string;
  teacher_id: string | null;
  teacher_name: string | null;
  day: string;
  starts_at: string;
  ends_at: string;
  submitted_at: Date;
  submitted_by_name: string | null;
  late: boolean;
  updated_at: Date;
};
const SESSION = Prisma.sql`
  SELECT s.id, s.lesson_id, s.academic_year_id, s.group_id, g.name AS group_name, sub.name AS subject_name, s.teacher_id, e.full_name AS teacher_name,
         to_char(s.day, 'YYYY-MM-DD') AS day, to_char(s.starts_at, 'HH24:MI') AS starts_at, to_char(s.ends_at, 'HH24:MI') AS ends_at,
         s.submitted_at, u.full_name AS submitted_by_name, s.late, s.updated_at, ${COUNTS("s")}
    FROM lesson_sessions s JOIN class_groups g ON g.id = s.group_id JOIN subjects sub ON sub.id = s.subject_id
    LEFT JOIN employees e ON e.id = s.teacher_id LEFT JOIN school_users u ON u.id = s.submitted_by_id`;
const session = (r: SessionRaw): SessionRow => ({
  id: r.id,
  lessonId: r.lesson_id,
  yearId: r.academic_year_id,
  groupId: r.group_id,
  groupName: r.group_name,
  subjectName: r.subject_name,
  teacherId: r.teacher_id,
  teacherName: r.teacher_name,
  day: r.day,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  submittedAt: r.submitted_at,
  submittedByName: r.submitted_by_name,
  late: r.late,
  updatedAt: r.updated_at,
  counts: counts(r),
});

type GroupRaw = { id: string; name: string; class_id: string; grade: number; course_name: string | null; shift: string; students: number; sessions: number };
const GROUP = Prisma.sql`
  SELECT g.id, g.name, g.class_id, c.grade, co.name AS course_name, g.shift,
         (SELECT count(*) FROM enrollments en WHERE en.group_id = g.id AND en.status = 'ACTIVE')::int AS students,
         (SELECT count(*) FROM lesson_sessions s WHERE s.group_id = g.id)::int AS sessions
    FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id`;
const group = (r: GroupRaw): GroupRow => ({ id: r.id, name: r.name, classId: r.class_id, grade: r.grade, courseName: r.course_name, shift: r.shift, students: r.students, sessions: r.sessions });

export class PrismaPresenceRepository implements PresenceRepository {
  constructor(private readonly db: PrismaClient) {}

  async employeeOfUser(userId: string) {
    return this.db.employee.findUnique({ where: { userId }, select: { id: true, fullName: true } });
  }

  async yearOn(day: string) {
    const r = await this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM academic_years WHERE ${day}::date BETWEEN starts_on AND ends_on ORDER BY (status = 'ACTIVE') DESC, starts_on LIMIT 1`;
    return r[0] ?? null;
  }

  async currentYear(today: string) {
    const r = await this.db.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM academic_years
       WHERE status = 'ACTIVE' OR (status <> 'CLOSED' AND ends_on >= ${today}::date)
       ORDER BY (status = 'ACTIVE') DESC, starts_on LIMIT 1`;
    return r[0] ?? null;
  }

  async closureOn(yearId: string, day: string) {
    const r = await this.db.$queryRaw<{ kind: string; reason: string }[]>`
      SELECT kind, reason FROM school_closures WHERE academic_year_id = ${yearId}::uuid AND ${day}::date BETWEEN starts_on AND ends_on LIMIT 1`;
    return r[0] ? { kindLabel: { FERIADO: "Feriado", PAUSA: "Pausa letiva", OUTRO: "Sem aulas" }[r[0].kind] ?? "Sem aulas", reason: r[0].reason } : null;
  }

  async teacherLessons(employeeId: string, yearId: string, day: string): Promise<TeacherLessonRow[]> {
    const rows = await this.db.$queryRaw<
      (Partial<CountRaw> & { lesson_id: string; starts_at: string; ends_at: string; group_id: string; group_name: string; subject_id: string; subject_name: string; color: string; room: string | null; session_id: string | null; submitted_at: Date | null; late: boolean | null; original_name: string | null })[]
    >`
      SELECT l.id AS lesson_id, to_char(p.starts_at, 'HH24:MI') AS starts_at, to_char(p.ends_at, 'HH24:MI') AS ends_at, g.id AS group_id, g.name AS group_name,
             sub.id AS subject_id, sub.name AS subject_name, sub.color, coalesce(l.room, g.room) AS room,
             s.id AS session_id, s.submitted_at, s.late, ${COUNTS("s")},
             CASE WHEN xs.substitute_id = ${employeeId}::uuid THEN coalesce(eo.full_name, '—') END AS original_name
        FROM lessons l JOIN school_periods p ON p.id = l.period_id JOIN class_groups g ON g.id = l.group_id JOIN subjects sub ON sub.id = l.subject_id
        LEFT JOIN lesson_sessions s ON s.group_id = l.group_id AND s.day = ${day}::date AND s.starts_at = date_trunc('minute', p.starts_at::interval)::time
        LEFT JOIN lesson_substitutions xs ON xs.lesson_id = l.id AND xs.day = ${day}::date
        LEFT JOIN employees eo ON eo.id = l.teacher_id
       WHERE l.academic_year_id = ${yearId}::uuid AND l.weekday = extract(isodow FROM ${day}::date)::int
         -- as suas aulas (menos as que alguém substitui nesse dia) e as que ele substitui
         AND ((l.teacher_id = ${employeeId}::uuid AND xs.id IS NULL) OR xs.substitute_id = ${employeeId}::uuid)
       ORDER BY p.starts_at`;
    return rows.map((r) => ({
      lessonId: r.lesson_id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      groupId: r.group_id,
      groupName: r.group_name,
      subjectId: r.subject_id,
      subjectName: r.subject_name,
      subjectColor: r.color,
      room: r.room,
      session: r.session_id ? { id: r.session_id, submittedAt: r.submitted_at as Date, late: !!r.late, counts: counts(r as CountRaw) } : null,
      substitutionFor: r.original_name,
    }));
  }

  async substituteOn(lessonId: string, day: string) {
    const r = await this.db.$queryRaw<{ substitute_id: string }[]>`SELECT substitute_id FROM lesson_substitutions WHERE lesson_id = ${lessonId}::uuid AND day = ${day}::date`;
    return r[0]?.substitute_id ?? null;
  }

  async resolvePending(groupId: string, day: string, startsAt: string, now: Date) {
    await this.db.$executeRaw`UPDATE lesson_pendings SET status = 'SUBMITTED_LATE', decided_at = ${now} WHERE group_id = ${groupId}::uuid AND day = ${day}::date AND starts_at = ${startsAt}::time AND status = 'OPEN'`;
  }

  async lesson(lessonId: string): Promise<LessonRow | null> {
    const r = await this.db.$queryRaw<{ id: string; year_id: string; group_id: string; group_name: string; subject_id: string; subject_name: string; teacher_id: string | null; weekday: number; starts_at: string; ends_at: string }[]>`
      SELECT l.id, l.academic_year_id AS year_id, l.group_id, g.name AS group_name, l.subject_id, sub.name AS subject_name, l.teacher_id, l.weekday,
             to_char(p.starts_at, 'HH24:MI') AS starts_at, to_char(p.ends_at, 'HH24:MI') AS ends_at
        FROM lessons l JOIN school_periods p ON p.id = l.period_id JOIN class_groups g ON g.id = l.group_id JOIN subjects sub ON sub.id = l.subject_id
       WHERE l.id = ${lessonId}::uuid`;
    const x = r[0];
    return x ? { id: x.id, yearId: x.year_id, groupId: x.group_id, groupName: x.group_name, subjectId: x.subject_id, subjectName: x.subject_name, teacherId: x.teacher_id, weekday: x.weekday, startsAt: x.starts_at, endsAt: x.ends_at } : null;
  }

  async roster(groupId: string): Promise<RosterRow[]> {
    return this.db.$queryRaw<RosterRow[]>`
      SELECT st.id, st.full_name AS "fullName", lpad(st.number::text, 5, '0') AS number
        FROM enrollments en JOIN students st ON st.id = en.student_id
       WHERE en.group_id = ${groupId}::uuid AND en.status = 'ACTIVE' ORDER BY st.full_name`;
  }

  async sessionAt(groupId: string, day: string, startsAt: string) {
    const r = await this.db.$queryRaw<SessionRaw[]>`${SESSION} WHERE s.group_id = ${groupId}::uuid AND s.day = ${day}::date AND s.starts_at = ${startsAt}::time`;
    return r[0] ? session(r[0]) : null;
  }

  async sessionById(id: string) {
    const r = await this.db.$queryRaw<SessionRaw[]>`${SESSION} WHERE s.id = ${id}::uuid`;
    return r[0] ? session(r[0]) : null;
  }

  async marks(sessionId: string): Promise<SessionMarkRow[]> {
    const r = await this.db.$queryRaw<{ student_id: string; full_name: string; number: string | null; status: string; minutes_late: number | null; note: string | null }[]>`
      SELECT a.student_id, st.full_name, lpad(st.number::text, 5, '0') AS number, a.status, a.minutes_late, a.note
        FROM student_attendance a JOIN students st ON st.id = a.student_id WHERE a.session_id = ${sessionId}::uuid ORDER BY st.full_name`;
    return r.map((x) => ({ studentId: x.student_id, fullName: x.full_name, number: x.number, status: x.status as PresenceStatus, minutesLate: x.minutes_late, note: x.note }));
  }

  private writeMarks(tx: Prisma.TransactionClient, sessionId: string, marks: Mark[], actorId: string | null, now: Date) {
    return [
      tx.$executeRaw`DELETE FROM student_attendance WHERE session_id = ${sessionId}::uuid AND NOT (student_id = ANY(${marks.map((m) => m.studentId)}::uuid[]))`,
      ...marks.map(
        (m) => tx.$executeRaw`
          INSERT INTO student_attendance (session_id, student_id, status, minutes_late, note, updated_by_id, updated_at)
          VALUES (${sessionId}::uuid, ${m.studentId}::uuid, ${m.status}, ${m.minutesLate}, ${m.note}, ${actorId}::uuid, ${now})
          ON CONFLICT (session_id, student_id) DO UPDATE SET status = EXCLUDED.status, minutes_late = EXCLUDED.minutes_late, note = EXCLUDED.note,
                 updated_by_id = CASE WHEN (student_attendance.status, student_attendance.minutes_late, student_attendance.note) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.minutes_late, EXCLUDED.note) THEN EXCLUDED.updated_by_id ELSE student_attendance.updated_by_id END,
                 updated_at = CASE WHEN (student_attendance.status, student_attendance.minutes_late, student_attendance.note) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.minutes_late, EXCLUDED.note) THEN EXCLUDED.updated_at ELSE student_attendance.updated_at END`,
      ),
    ];
  }

  async saveSession(
    i: { id: string; lessonId: string | null; yearId: string; groupId: string; subjectId: string; teacherId: string | null; day: string; startsAt: string; endsAt: string; late: boolean },
    marks: Mark[],
    actorId: string | null,
    now: Date,
  ) {
    return this.db.$transaction(async (tx) => {
      // uma aula por turma + dia + hora: se outra janela já a criou, usa-se essa (sem duplicados)
      const r = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO lesson_sessions (id, lesson_id, academic_year_id, group_id, subject_id, teacher_id, day, starts_at, ends_at, submitted_at, submitted_by_id, late, created_at, updated_at)
        VALUES (${i.id}::uuid, ${i.lessonId}::uuid, ${i.yearId}::uuid, ${i.groupId}::uuid, ${i.subjectId}::uuid, ${i.teacherId}::uuid, ${i.day}::date, ${i.startsAt}::time, ${i.endsAt}::time, ${now}, ${actorId}::uuid, ${i.late}, ${now}, ${now})
        ON CONFLICT (group_id, day, starts_at) DO UPDATE SET updated_at = EXCLUDED.updated_at
        RETURNING id`;
      const id = r[0].id;
      for (const q of this.writeMarks(tx, id, marks, actorId, now)) await q;
      return id;
    });
  }

  async replaceMarks(sessionId: string, marks: Mark[], actorId: string | null, now: Date) {
    await this.db.$transaction(async (tx) => {
      for (const q of this.writeMarks(tx, sessionId, marks, actorId, now)) await q;
      await tx.$executeRaw`UPDATE lesson_sessions SET updated_at = ${now} WHERE id = ${sessionId}::uuid`;
    });
  }

  async teacherGroups(employeeId: string) {
    const r = await this.db.$queryRaw<(GroupRaw & { subjects: string[] })[]>`
      ${GROUP}
       WHERE g.id IN (SELECT l.group_id FROM lessons l JOIN academic_years y ON y.id = l.academic_year_id WHERE l.teacher_id = ${employeeId}::uuid AND y.status <> 'CLOSED')
          OR g.id IN (SELECT s.group_id FROM lesson_sessions s WHERE s.teacher_id = ${employeeId}::uuid)`;
    const subj = await this.db.$queryRaw<{ group_id: string; name: string }[]>`
      SELECT DISTINCT l.group_id, sub.name FROM lessons l JOIN subjects sub ON sub.id = l.subject_id WHERE l.teacher_id = ${employeeId}::uuid`;
    return r
      .map((x) => ({ ...group(x), subjects: subj.filter((s) => s.group_id === x.id).map((s) => s.name) }))
      .sort((a, b) => a.grade - b.grade || a.name.localeCompare(b.name));
  }

  async groupSessions(groupId: string, teacherId?: string) {
    const r = teacherId
      ? await this.db.$queryRaw<SessionRaw[]>`${SESSION} WHERE s.group_id = ${groupId}::uuid AND s.teacher_id = ${teacherId}::uuid ORDER BY s.day DESC, s.starts_at DESC LIMIT 200`
      : await this.db.$queryRaw<SessionRaw[]>`${SESSION} WHERE s.group_id = ${groupId}::uuid ORDER BY s.day DESC, s.starts_at DESC LIMIT 200`;
    return r.map(session);
  }

  async groupStudents(groupId: string): Promise<StudentSummaryRow[]> {
    const r = await this.db.$queryRaw<(CountRaw & { id: string; full_name: string; number: string | null })[]>`
      SELECT st.id, st.full_name, lpad(st.number::text, 5, '0') AS number,
             count(a.*) FILTER (WHERE a.status = 'PRESENTE')::int AS present, count(a.*) FILTER (WHERE a.status = 'AUSENTE')::int AS absent,
             count(a.*) FILTER (WHERE a.status = 'ATRASADO')::int AS late_n, count(a.*) FILTER (WHERE a.status = 'FALTA_JUSTIFICADA')::int AS justified,
             count(a.*)::int AS total
        FROM enrollments en JOIN students st ON st.id = en.student_id
        LEFT JOIN lesson_sessions s ON s.group_id = en.group_id
        LEFT JOIN student_attendance a ON a.session_id = s.id AND a.student_id = st.id
       WHERE en.group_id = ${groupId}::uuid AND en.status = 'ACTIVE'
       GROUP BY st.id, st.full_name, st.number ORDER BY st.full_name`;
    return r.map((x) => ({ id: x.id, fullName: x.full_name, number: x.number, counts: counts(x) }));
  }

  async yearGroups(yearId: string) {
    const r = await this.db.$queryRaw<GroupRaw[]>`${GROUP} WHERE g.academic_year_id = ${yearId}::uuid ORDER BY c.grade, co.name NULLS FIRST, g.name`;
    return r.map(group);
  }

  async group(groupId: string) {
    const r = await this.db.$queryRaw<(GroupRaw & { year_id: string })[]>`
      SELECT q.*, g2.academic_year_id AS year_id FROM (${GROUP} WHERE g.id = ${groupId}::uuid) q JOIN class_groups g2 ON g2.id = q.id`;
    return r[0] ? { ...group(r[0]), yearId: r[0].year_id } : null;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  async history(sessionId: string) {
    const r = await this.db.$queryRaw<{ occurred_at: Date; type: string; by: string | null; details: unknown }[]>`
      SELECT a.occurred_at, a.type, u.full_name AS by, a.details FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id
       WHERE a.subject_id = ${sessionId}::uuid AND a.type LIKE 'LESSON_ATTENDANCE_%' ORDER BY a.occurred_at`;
    return r.map((x) => ({ at: x.occurred_at, type: x.type, actorName: x.by, details: x.details as never }));
  }
}
