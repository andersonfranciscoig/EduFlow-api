import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { groupLabel } from "../../exams/domain/exams";
import { lessonsSuspended } from "../../exams/infrastructure/exam-break";
import type { PresenceStatus } from "../domain/presence";

/** O que o relatório abrange (datas "AAAA-MM-DD"; os filtros vazios não contam). */
export interface ReportScope {
  yearId: string;
  from: string;
  to: string;
  classId?: string;
  groupId?: string;
  subjectId?: string;
  teacherId?: string;
}
export interface Tally {
  sessions: number;
  late: number;
  noSummary: number;
  present: number;
  absent: number;
  lateMarks: number;
  justified: number;
  total: number;
}
export interface ReportYear {
  id: string;
  name: string;
  status: string;
  periodKind: string;
  startsOn: string;
  endsOn: string;
}
type TallyRaw = { kind: number; group_id: string | null; subject_id: string | null; week: string | null; sessions: number; late: number; no_summary: number; present: number; absent: number; late_n: number; justified: number; total: number };
const tally = (r: TallyRaw): Tally => ({ sessions: r.sessions, late: r.late, noSummary: r.no_summary, present: r.present ?? 0, absent: r.absent ?? 0, lateMarks: r.late_n ?? 0, justified: r.justified ?? 0, total: r.total ?? 0 });
const EMPTY: Tally = { sessions: 0, late: 0, noSummary: 0, present: 0, absent: 0, lateMarks: 0, justified: 0, total: 0 };

/** Relatórios e painéis da assiduidade (só leitura), na BD do colégio. */
export class PrismaReportsRepository {
  constructor(private readonly db: PrismaClient) {}

  async years(): Promise<ReportYear[]> {
    return this.db.$queryRaw<ReportYear[]>`
      SELECT id, name, status, period_kind AS "periodKind", to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM academic_years ORDER BY starts_on DESC`;
  }

  async periods(yearId: string) {
    return this.db.$queryRaw<{ position: number; startsOn: string; endsOn: string }[]>`
      SELECT position, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM academic_periods WHERE academic_year_id = ${yearId}::uuid ORDER BY position`;
  }

  /** Turmas, disciplinas e professores que se podem escolher (do horário ou com aulas registadas). teacherId/groupId limitam. */
  async options(yearId: string, only: { teacherId?: string; groupId?: string } = {}) {
    const t = only.teacherId ? Prisma.sql`AND x.teacher_id = ${only.teacherId}::uuid` : Prisma.empty;
    const g = only.groupId ? Prisma.sql`AND x.group_id = ${only.groupId}::uuid` : Prisma.empty;
    const [rows] = await this.db.$queryRaw<
      {
        data: {
          groups: { id: string; name: string; classId: string; grade: number; courseId: string | null; courseName: string | null; courseCode: string | null; shift: string; room: string | null }[];
          subjects: { id: string; name: string; color: string; groupIds: string[] }[];
          teachers: { id: string; fullName: string }[];
        };
      }[]
    >`
      WITH x AS (
        SELECT DISTINCT group_id, subject_id, teacher_id FROM (
          SELECT l.group_id, l.subject_id, l.teacher_id FROM lessons l WHERE l.academic_year_id = ${yearId}::uuid
          UNION ALL SELECT s.group_id, s.subject_id, s.teacher_id FROM lesson_sessions s WHERE s.academic_year_id = ${yearId}::uuid) u),
      f AS (SELECT * FROM x WHERE true ${t} ${g})
      SELECT json_build_object(
        'groups', (SELECT coalesce(json_agg(json_build_object('id', g.id, 'name', g.name, 'classId', g.class_id, 'grade', c.grade, 'courseId', c.course_id, 'courseName', co.name, 'courseCode', co.code, 'shift', g.shift, 'room', g.room) ORDER BY c.grade, co.name, g.name), '[]'::json)
                     FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id WHERE g.academic_year_id = ${yearId}::uuid AND g.id IN (SELECT group_id FROM f)),
        'subjects', (SELECT coalesce(json_agg(json_build_object('id', su.id, 'name', su.name, 'color', su.color, 'groupIds', (SELECT json_agg(DISTINCT f2.group_id) FROM f f2 WHERE f2.subject_id = su.id)) ORDER BY su.name), '[]'::json)
                     FROM subjects su WHERE su.id IN (SELECT subject_id FROM f)),
        'teachers', (SELECT coalesce(json_agg(json_build_object('id', e.id, 'fullName', e.full_name) ORDER BY e.full_name), '[]'::json) FROM employees e WHERE e.id IN (SELECT teacher_id FROM f))
      ) AS data`;
    const d = rows.data;
    return { ...d, groups: d.groups.map(({ courseCode, ...x }) => ({ ...x, label: groupLabel({ name: x.name, grade: x.grade, courseCode }) })) };
  }

  /** Filtro das aulas (alias s) pela turma, classe, disciplina e professor. */
  private where(f: ReportScope, a = "s") {
    const c = (n: string) => Prisma.raw(`${a}.${n}`);
    return Prisma.join(
      [
        Prisma.sql`${c("academic_year_id")} = ${f.yearId}::uuid`,
        Prisma.sql`${c("day")} BETWEEN ${f.from}::date AND ${f.to}::date`,
        ...(f.groupId ? [Prisma.sql`${c("group_id")} = ${f.groupId}::uuid`] : []),
        ...(f.classId ? [Prisma.sql`${c("group_id")} IN (SELECT id FROM class_groups WHERE class_id = ${f.classId}::uuid)`] : []),
        ...(f.subjectId ? [Prisma.sql`${c("subject_id")} = ${f.subjectId}::uuid`] : []),
        ...(f.teacherId ? [Prisma.sql`${c("teacher_id")} = ${f.teacherId}::uuid`] : []),
      ],
      " AND ",
    );
  }

  /** Totais, por semana, por turma e por disciplina (uma só leitura das aulas). */
  async tallies(f: ReportScope) {
    const rows = await this.db.$queryRaw<TallyRaw[]>`
      WITH base AS (
        SELECT s.id, s.group_id, s.subject_id, to_char(date_trunc('week', s.day), 'YYYY-MM-DD') AS week, s.late, s.summary IS NULL AS no_summary, a.*
          FROM lesson_sessions s
          CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE status = 'PRESENTE')::int AS present, count(*) FILTER (WHERE status = 'AUSENTE')::int AS absent, count(*) FILTER (WHERE status = 'ATRASADO')::int AS late_n,
                   count(*) FILTER (WHERE status = 'FALTA_JUSTIFICADA')::int AS justified, count(*)::int AS total
              FROM student_attendance WHERE session_id = s.id) a
         WHERE ${this.where(f)})
      SELECT GROUPING(group_id, subject_id, week)::int AS kind, group_id, subject_id, week, count(*)::int AS sessions, count(*) FILTER (WHERE late)::int AS late, count(*) FILTER (WHERE no_summary)::int AS no_summary,
             sum(present)::int AS present, sum(absent)::int AS absent, sum(late_n)::int AS late_n, sum(justified)::int AS justified, sum(total)::int AS total
        FROM base GROUP BY GROUPING SETS ((), (group_id), (subject_id), (week))`;
    const all = rows.find((r) => r.kind === 7);
    return {
      totals: all ? tally(all) : EMPTY,
      groups: new Map(rows.filter((r) => r.kind === 3).map((r) => [r.group_id!, tally(r)])),
      subjects: new Map(rows.filter((r) => r.kind === 5).map((r) => [r.subject_id!, tally(r)])),
      weeks: rows
        .filter((r) => r.kind === 6)
        .map((r) => ({ week: r.week!, ...tally(r) }))
        .sort((a, b) => a.week.localeCompare(b.week)),
    };
  }

  /** Os alunos com mais faltas (não justificadas) e as presenças de cada um, da mais recente à mais antiga. */
  async absentees(f: ReportScope, limit: number) {
    const rows = await this.db.$queryRaw<{ id: string; full_name: string; group_id: string; present: number; absent: number; late_n: number; justified: number; total: number; marks: PresenceStatus[] }[]>`
      SELECT st.id, st.full_name, s.group_id, count(*) FILTER (WHERE a.status = 'PRESENTE')::int AS present, count(*) FILTER (WHERE a.status = 'AUSENTE')::int AS absent, count(*) FILTER (WHERE a.status = 'ATRASADO')::int AS late_n,
             count(*) FILTER (WHERE a.status = 'FALTA_JUSTIFICADA')::int AS justified, count(*)::int AS total, array_agg(a.status ORDER BY s.day DESC, s.starts_at DESC) AS marks
        FROM student_attendance a JOIN lesson_sessions s ON s.id = a.session_id JOIN students st ON st.id = a.student_id
       WHERE ${this.where(f)} GROUP BY st.id, st.full_name, s.group_id HAVING count(*) FILTER (WHERE a.status = 'AUSENTE') > 0
       ORDER BY count(*) FILTER (WHERE a.status = 'AUSENTE') DESC, st.full_name LIMIT ${limit}`;
    return rows.map((r) => {
      // faltas seguidas até à última aula (as justificadas não contam nem interrompem)
      let streak = 0;
      for (const m of r.marks) {
        if (m === "AUSENTE") streak++;
        else if (m !== "FALTA_JUSTIFICADA") break;
      }
      return { id: r.id, fullName: r.full_name, groupId: r.group_id, present: r.present, absent: r.absent, lateMarks: r.late_n, justified: r.justified, total: r.total, streak };
    });
  }

  /** Quantos alunos estão no limite de faltas ou de faltas seguidas das regras (em cada turma). */
  async atRisk(f: ReportScope, absenceLimit: number, consecutiveLimit: number) {
    const rows = await this.db.$queryRaw<{ absent: number; marks: PresenceStatus[] }[]>`
      SELECT count(*) FILTER (WHERE a.status = 'AUSENTE')::int AS absent, (array_agg(a.status ORDER BY s.day DESC, s.starts_at DESC) FILTER (WHERE a.status <> 'FALTA_JUSTIFICADA'))[1:${consecutiveLimit}::int] AS marks
        FROM student_attendance a JOIN lesson_sessions s ON s.id = a.session_id WHERE ${this.where(f)} GROUP BY a.student_id, s.group_id
      HAVING count(*) FILTER (WHERE a.status = 'AUSENTE') >= ${Math.min(absenceLimit, consecutiveLimit)}::int`;
    return rows.filter((r) => r.absent >= absenceLimit || (r.marks?.length === consecutiveLimit && r.marks.every((m) => m === "AUSENTE"))).length;
  }

  /** Aulas cujo prazo passou sem presenças: quantas em cada estado e as mais recentes por decidir. */
  async pendings(f: ReportScope, limit: number) {
    const [counts, items] = await Promise.all([
      this.db.$queryRaw<{ status: string; n: number }[]>`SELECT p.status, count(*)::int AS n FROM lesson_pendings p WHERE ${this.where(f, "p")} GROUP BY p.status`,
      this.db.$queryRaw<{ id: string; day: string; startsAt: string; groupName: string; subjectName: string; teacherName: string | null; status: string }[]>`
        SELECT p.id, to_char(p.day, 'YYYY-MM-DD') AS day, to_char(p.starts_at, 'HH24:MI') AS "startsAt", p.group_name AS "groupName", p.subject_name AS "subjectName", e.full_name AS "teacherName", p.status
          FROM lesson_pendings p LEFT JOIN employees e ON e.id = p.teacher_id WHERE ${this.where(f, "p")} AND p.status = 'OPEN' ORDER BY p.day DESC, p.starts_at LIMIT ${limit}`,
    ]);
    const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    return { open: n("OPEN"), lateSubmitted: n("SUBMITTED_LATE"), faults: n("FAULT"), dismissed: n("DISMISSED"), items };
  }

  /**
   * Aulas previstas (horário, sem dias sem aulas nem épocas de provas com interrupção) já terminadas e
   * quantas têm presenças: no total, por professor e por turma. Conta desde que o controlo começou.
   */
  async coverage(f: ReportScope, since: string, nowLocal: string) {
    const from = f.from > since ? f.from : since;
    const today = nowLocal.slice(0, 10);
    const to = f.to < today ? f.to : today;
    if (from > to) return [];
    return this.db.$queryRaw<{ kind: number; teacher_id: string | null; group_id: string | null; planned: number; recorded: number; late: number }[]>`
      WITH planned AS (
        SELECT coalesce(sub.substitute_id, l.teacher_id) AS teacher_id, l.group_id, ss.id AS session_id, ss.late
          FROM generate_series(${from}::date, ${to}::date, interval '1 day') d0 CROSS JOIN LATERAL (SELECT d0::date AS day) d
          JOIN lessons l ON l.weekday = extract(isodow FROM d.day)::int AND l.academic_year_id = ${f.yearId}::uuid
          JOIN school_periods p ON p.id = l.period_id JOIN class_groups g ON g.id = l.group_id
          LEFT JOIN lesson_substitutions sub ON sub.lesson_id = l.id AND sub.day = d.day
          LEFT JOIN lesson_sessions ss ON ss.group_id = l.group_id AND ss.day = d.day AND ss.starts_at = date_trunc('minute', p.starts_at::interval)::time
         WHERE (d.day + p.ends_at) <= ${nowLocal}::timestamp AND coalesce(sub.substitute_id, l.teacher_id) IS NOT NULL
           ${f.groupId ? Prisma.sql`AND l.group_id = ${f.groupId}::uuid` : Prisma.empty} ${f.classId ? Prisma.sql`AND g.class_id = ${f.classId}::uuid` : Prisma.empty}
           ${f.subjectId ? Prisma.sql`AND l.subject_id = ${f.subjectId}::uuid` : Prisma.empty} ${f.teacherId ? Prisma.sql`AND coalesce(sub.substitute_id, l.teacher_id) = ${f.teacherId}::uuid` : Prisma.empty}
           AND (ss.id IS NOT NULL OR (NOT EXISTS (SELECT 1 FROM school_closures c WHERE c.academic_year_id = l.academic_year_id AND d.day BETWEEN c.starts_on AND c.ends_on) AND NOT ${lessonsSuspended("l.group_id", "d.day")})))
      SELECT GROUPING(teacher_id, group_id)::int AS kind, teacher_id, group_id, count(*)::int AS planned, count(session_id)::int AS recorded, count(*) FILTER (WHERE late)::int AS late
        FROM planned GROUP BY GROUPING SETS ((), (teacher_id), (group_id))`;
  }

  async alerts(f: ReportScope) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM attendance_alerts a JOIN class_groups g ON g.id = a.group_id
       WHERE g.academic_year_id = ${f.yearId}::uuid AND a.created_at >= ${f.from}::date AND a.created_at < ${f.to}::date + 1
         ${f.groupId ? Prisma.sql`AND g.id = ${f.groupId}::uuid` : Prisma.empty} ${f.classId ? Prisma.sql`AND g.class_id = ${f.classId}::uuid` : Prisma.empty}
         ${f.teacherId ? Prisma.sql`AND g.id IN (SELECT group_id FROM lesson_sessions WHERE teacher_id = ${f.teacherId}::uuid)` : Prisma.empty}`;
    return r?.n ?? 0;
  }

  /** A situação de cada época de provas do ano (e, com turma ou classe, só as que a abrangem). */
  async exams(f: ReportScope) {
    return this.db.$queryRaw<{ id: string; name: string; period: number; startsOn: string | null; endsOn: string | null; status: string; interrupts: boolean; scheduled: number; expected: number }[]>`
      SELECT s.id, s.name, s.period_position AS period, to_char(s.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(s.ends_on, 'YYYY-MM-DD') AS "endsOn", s.status, s.interrupts,
             (SELECT count(DISTINCT (e.group_id, e.subject_id)) FROM exams e WHERE e.season_id = s.id AND e.status = 'SCHEDULED')::int AS scheduled,
             (SELECT count(*) FROM exam_season_groups sg JOIN class_groups g ON g.id = sg.group_id JOIN exam_season_subjects ss ON ss.season_id = s.id AND ss.class_id = g.class_id WHERE sg.season_id = s.id)::int AS expected
        FROM exam_seasons s WHERE s.academic_year_id = ${f.yearId}::uuid
         ${f.groupId || f.classId ? Prisma.sql`AND EXISTS (SELECT 1 FROM exam_season_groups sg JOIN class_groups g ON g.id = sg.group_id WHERE sg.season_id = s.id AND ${f.groupId ? Prisma.sql`g.id = ${f.groupId}::uuid` : Prisma.sql`g.class_id = ${f.classId}::uuid`})` : Prisma.empty}
       ORDER BY s.period_position, s.position`;
  }

  // ------------------------------------------------------------------ RH

  /** Faltas e atrasos por professor e por semana (as anuladas não contam). */
  async occurrences(f: ReportScope) {
    const t = f.teacherId ? Prisma.sql`AND o.employee_id = ${f.teacherId}::uuid` : Prisma.empty;
    const [byTeacher, byWeek, list, justifications] = await Promise.all([
      this.db.$queryRaw<{ id: string; full_name: string; faults: number; justified: number; delays: number; automatic: number; annulled: number }[]>`
        SELECT e.id, e.full_name, count(*) FILTER (WHERE o.kind = 'FALTA' AND o.status <> 'ANULADA')::int AS faults, count(*) FILTER (WHERE o.kind = 'FALTA' AND o.status = 'JUSTIFICADA')::int AS justified,
               count(*) FILTER (WHERE o.kind = 'ATRASO' AND o.status <> 'ANULADA')::int AS delays, count(*) FILTER (WHERE o.source = 'AUTOMATIC' AND o.status <> 'ANULADA')::int AS automatic,
               count(*) FILTER (WHERE o.status = 'ANULADA')::int AS annulled
          FROM teacher_occurrences o JOIN employees e ON e.id = o.employee_id WHERE o.day BETWEEN ${f.from}::date AND ${f.to}::date ${t} GROUP BY e.id, e.full_name`,
      this.db.$queryRaw<{ week: string; faults: number; delays: number }[]>`
        SELECT to_char(date_trunc('week', o.day), 'YYYY-MM-DD') AS week, count(*) FILTER (WHERE o.kind = 'FALTA')::int AS faults, count(*) FILTER (WHERE o.kind = 'ATRASO')::int AS delays
          FROM teacher_occurrences o WHERE o.status <> 'ANULADA' AND o.day BETWEEN ${f.from}::date AND ${f.to}::date ${t} GROUP BY 1 ORDER BY 1`,
      this.db.$queryRaw<{ id: string; day: string; teacherName: string; scope: string; kind: string; status: string; source: string; what: string | null }[]>`
        SELECT o.id, to_char(o.day, 'YYYY-MM-DD') AS day, e.full_name AS "teacherName", o.scope, o.kind, o.status, o.source,
               CASE WHEN o.scope = 'LESSON' THEN concat_ws(' · ', to_char(o.starts_at, 'HH24:MI'), o.subject_name, o.group_name) END AS what
          FROM teacher_occurrences o JOIN employees e ON e.id = o.employee_id WHERE o.day BETWEEN ${f.from}::date AND ${f.to}::date ${t} ORDER BY o.day DESC, o.starts_at DESC NULLS LAST, e.full_name LIMIT 60`,
      this.db.$queryRaw<{ status: string; n: number }[]>`
        SELECT j.status, count(*)::int AS n FROM occurrence_justifications j JOIN teacher_occurrences o ON o.id = j.occurrence_id WHERE o.day BETWEEN ${f.from}::date AND ${f.to}::date ${t} GROUP BY j.status`,
    ]);
    return { byTeacher, byWeek, list, justifications };
  }

  async openPendingsByTeacher(f: ReportScope) {
    const r = await this.db.$queryRaw<{ teacher_id: string; n: number }[]>`SELECT p.teacher_id, count(*)::int AS n FROM lesson_pendings p WHERE ${this.where(f, "p")} AND p.status = 'OPEN' AND p.teacher_id IS NOT NULL GROUP BY p.teacher_id`;
    return new Map(r.map((x) => [x.teacher_id, x.n]));
  }

  async names(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const r = await this.db.$queryRaw<{ id: string; full_name: string }[]>`SELECT id, full_name FROM employees WHERE id = ANY(${ids}::uuid[])`;
    return new Map(r.map((x) => [x.id, x.full_name]));
  }

  // ------------------------------------------------------------------ professor

  async employeeOfUser(userId: string) {
    const r = await this.db.$queryRaw<{ id: string; fullName: string }[]>`SELECT id, full_name AS "fullName" FROM employees WHERE user_id = ${userId}::uuid`;
    return r[0] ?? null;
  }

  async coordinatedGroups(employeeId: string, yearId: string) {
    const r = await this.db.$queryRaw<{ id: string; name: string; grade: number; courseCode: string | null }[]>`
      SELECT g.id, g.name, c.grade, co.code AS "courseCode" FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE g.coordinator_id = ${employeeId}::uuid AND g.academic_year_id = ${yearId}::uuid ORDER BY c.grade, g.name`;
    return r.map((g) => ({ id: g.id, label: groupLabel(g) }));
  }
}
