import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { PresenceStatus } from "../domain/presence";

type CountRaw = { present: number; absent: number; late_n: number; justified: number; total: number };
const counts = (r: CountRaw) => ({ present: r.present ?? 0, absent: r.absent ?? 0, late: r.late_n ?? 0, justified: r.justified ?? 0, total: r.total ?? 0 });
const COUNT_COLS = Prisma.sql`
  count(a.*) FILTER (WHERE a.status = 'PRESENTE')::int AS present, count(a.*) FILTER (WHERE a.status = 'AUSENTE')::int AS absent,
  count(a.*) FILTER (WHERE a.status = 'ATRASADO')::int AS late_n, count(a.*) FILTER (WHERE a.status = 'FALTA_JUSTIFICADA')::int AS justified,
  count(a.*)::int AS total`;

export interface StandingRow {
  id: string;
  fullName: string;
  birthDate: string;
  accountId: string | null;
  absent: number;
  /** presenças na turma, da mais recente para a mais antiga (para as faltas seguidas) */
  marks: { status: PresenceStatus; day: string; startsAt: string }[];
}

/**
 * Assiduidade de cada aluno: os alertas (limites das regras) e a vista da família.
 * As faltas contam por turma (as aulas registadas dessa turma, de todas as disciplinas).
 */
export class PrismaStudentAttendanceRepository {
  constructor(private readonly db: PrismaClient) {}

  async sessionInfo(sessionId: string) {
    const [r] = await this.db.$queryRaw<{ group_id: string; group_name: string; coordinator_id: string | null; absent_ids: string[] }[]>`
      SELECT s.group_id, g.name AS group_name, g.coordinator_id,
             coalesce(array_agg(a.student_id) FILTER (WHERE a.status = 'AUSENTE'), '{}') AS absent_ids
        FROM lesson_sessions s JOIN class_groups g ON g.id = s.group_id LEFT JOIN student_attendance a ON a.session_id = s.id
       WHERE s.id = ${sessionId}::uuid GROUP BY s.group_id, g.name, g.coordinator_id`;
    return r ? { groupId: r.group_id, groupName: r.group_name, coordinatorId: r.coordinator_id, absentIds: r.absent_ids } : null;
  }

  /** Para cada aluno: faltas (não justificadas) na turma e as presenças, da mais recente à mais antiga. */
  async standing(groupId: string, studentIds: string[]): Promise<StandingRow[]> {
    if (!studentIds.length) return [];
    const [students, marks] = await Promise.all([
      this.db.$queryRaw<{ id: string; full_name: string; birth_date: string; account_id: string | null }[]>`
        SELECT id, full_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, account_id FROM students WHERE id = ANY(${studentIds}::uuid[])`,
      this.db.$queryRaw<{ student_id: string; status: PresenceStatus; day: string; starts_at: string }[]>`
        SELECT a.student_id, a.status, to_char(s.day, 'YYYY-MM-DD') AS day, to_char(s.starts_at, 'HH24:MI') AS starts_at
          FROM student_attendance a JOIN lesson_sessions s ON s.id = a.session_id
         WHERE s.group_id = ${groupId}::uuid AND a.student_id = ANY(${studentIds}::uuid[]) ORDER BY s.day DESC, s.starts_at DESC`,
    ]);
    return students.map((s) => {
      const mine = marks.filter((m) => m.student_id === s.id).map((m) => ({ status: m.status, day: m.day, startsAt: m.starts_at }));
      return { id: s.id, fullName: s.full_name, birthDate: s.birth_date, accountId: s.account_id, absent: mine.filter((m) => m.status === "AUSENTE").length, marks: mine };
    });
  }

  /** As contas dos encarregados que GEREM o aluno (os outros não têm acesso aos dados dele na área da família). */
  async guardianAccounts(studentId: string) {
    const r = await this.db.$queryRaw<{ account_id: string }[]>`
      SELECT DISTINCT g.account_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id JOIN family_accounts a ON a.id = g.account_id AND a.status = 'ACTIVE'
       WHERE sg.student_id = ${studentId}::uuid AND sg.can_manage`;
    return r.map((x) => x.account_id);
  }

  /** Grava o alerta (false = esse limite já foi avisado). */
  async saveAlert(a: { id: string; studentId: string; groupId: string; rule: "ABSENCES" | "STREAK"; key: string; count: number; sessionId: string; now: Date }) {
    const n = await this.db.$executeRaw`
      INSERT INTO attendance_alerts (id, student_id, group_id, rule, dedupe_key, count, session_id, created_at)
      VALUES (${a.id}::uuid, ${a.studentId}::uuid, ${a.groupId}::uuid, ${a.rule}, ${a.key}, ${a.count}, ${a.sessionId}::uuid, ${a.now})
      ON CONFLICT (student_id, dedupe_key) DO NOTHING`;
    return n === 1;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  // ---------------------------------------------------------------- a vista da família

  /**
   * A turma onde contam as presenças: a do ano letivo em curso (a renovação para o ano seguinte
   * também é uma matrícula ativa, mas ainda sem aulas); sem ano em curso, a matrícula mais recente.
   */
  async attendanceGroup(studentId: string, today: string) {
    const [r] = await this.db.$queryRaw<{ group_id: string }[]>`
      SELECT e.group_id FROM enrollments e JOIN class_groups g ON g.id = e.group_id JOIN academic_years y ON y.id = g.academic_year_id
       WHERE e.student_id = ${studentId}::uuid AND e.status = 'ACTIVE'
       ORDER BY (${today}::date BETWEEN y.starts_on AND y.ends_on) DESC, y.starts_on ASC, e.enrolled_at DESC LIMIT 1`;
    return r?.group_id ?? null;
  }

  async group(groupId: string) {
    const [r] = await this.db.$queryRaw<{ id: string; name: string; year_name: string }[]>`
      SELECT g.id, g.name, y.name AS year_name FROM class_groups g JOIN academic_years y ON y.id = g.academic_year_id WHERE g.id = ${groupId}::uuid`;
    return r ? { id: r.id, name: r.name, yearName: r.year_name } : null;
  }

  /** Por disciplina (as do horário da turma e as que têm aulas registadas). */
  async subjects(groupId: string, studentId: string) {
    const r = await this.db.$queryRaw<(CountRaw & { subject_name: string; color: string })[]>`
      SELECT sub.name AS subject_name, sub.color, ${COUNT_COLS}
        FROM subjects sub
        LEFT JOIN lesson_sessions s ON s.subject_id = sub.id AND s.group_id = ${groupId}::uuid
        LEFT JOIN student_attendance a ON a.session_id = s.id AND a.student_id = ${studentId}::uuid
       WHERE sub.id IN (SELECT subject_id FROM lessons WHERE group_id = ${groupId}::uuid UNION SELECT subject_id FROM lesson_sessions WHERE group_id = ${groupId}::uuid)
       GROUP BY sub.id, sub.name, sub.color ORDER BY sub.name`;
    return r.map((x) => ({ subjectName: x.subject_name, color: x.color, counts: counts(x) }));
  }

  /** As faltas, atrasos e faltas justificadas do aluno (as mais recentes primeiro). */
  async events(groupId: string, studentId: string, limit: number) {
    const r = await this.db.$queryRaw<{ day: string; starts_at: string; subject_name: string; status: PresenceStatus; minutes_late: number | null }[]>`
      SELECT to_char(s.day, 'YYYY-MM-DD') AS day, to_char(s.starts_at, 'HH24:MI') AS starts_at, sub.name AS subject_name, a.status, a.minutes_late
        FROM student_attendance a JOIN lesson_sessions s ON s.id = a.session_id JOIN subjects sub ON sub.id = s.subject_id
       WHERE s.group_id = ${groupId}::uuid AND a.student_id = ${studentId}::uuid AND a.status <> 'PRESENTE'
       ORDER BY s.day DESC, s.starts_at DESC LIMIT ${limit}`;
    return r.map((x) => ({ day: x.day, startsAt: x.starts_at, subjectName: x.subject_name, status: x.status, minutesLate: x.minutes_late }));
  }

  async alerts(groupId: string, studentId: string) {
    const r = await this.db.$queryRaw<{ rule: string; count: number; created_at: Date }[]>`
      SELECT rule, count, created_at FROM attendance_alerts WHERE group_id = ${groupId}::uuid AND student_id = ${studentId}::uuid ORDER BY created_at DESC LIMIT 20`;
    return r.map((x) => ({ rule: x.rule as "ABSENCES" | "STREAK", count: x.count, createdAt: x.created_at }));
  }
}
