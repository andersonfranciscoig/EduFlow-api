import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { lessonsSuspended } from "../../exams/infrastructure/exam-break";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import type { DayNotice, DigestContent, GroupDay, StudentDay, TeacherLesson } from "../domain/digest";
import type { PresenceStatus } from "../domain/presence";

export interface DueStaff {
  userId: string;
  fullName: string;
  employeeId: string;
  day: string;
  dueAt: string;
}
export interface DueFamily {
  accountId: string;
  fullName: string;
  email: string;
  day: string;
  dueAt: string;
  studentIds: string[];
}
export interface DigestRow {
  day: string;
  dueAt: string;
  headline: string;
  content: DigestContent;
  createdAt: Date;
}

/**
 * As aulas previstas em cada dia (horário do ano, sem dias sem aulas), com o professor desse dia
 * (o substituto, se houver) e a presença já registada. `days` = os dias a ver.
 */
const PLANNED = (days: string[]) => Prisma.sql`
  SELECT d.day, l.group_id, g.name AS group_name, g.coordinator_id, s.name AS subject_name, coalesce(sub.substitute_id, l.teacher_id) AS teacher_id, (sub.id IS NOT NULL) AS substitution,
         date_trunc('minute', p.starts_at::interval)::time AS starts_at, date_trunc('minute', p.ends_at::interval)::time AS ends_at, ss.id AS session_id, ss.late, ss.summary
    FROM unnest(${days}::date[]) AS d(day)
    JOIN lessons l ON l.weekday = extract(isodow FROM d.day)::int
    JOIN academic_years y ON y.id = l.academic_year_id AND y.status <> 'CLOSED' AND d.day BETWEEN y.starts_on AND y.ends_on
    JOIN school_periods p ON p.id = l.period_id
    JOIN class_groups g ON g.id = l.group_id
    JOIN subjects s ON s.id = l.subject_id
    LEFT JOIN lesson_substitutions sub ON sub.lesson_id = l.id AND sub.day = d.day
    LEFT JOIN lesson_sessions ss ON ss.group_id = l.group_id AND ss.day = d.day AND ss.starts_at = date_trunc('minute', p.starts_at::interval)::time
   WHERE NOT EXISTS (SELECT 1 FROM school_closures c WHERE c.academic_year_id = y.id AND d.day BETWEEN c.starts_on AND c.ends_on)
     AND (ss.id IS NOT NULL OR NOT ${lessonsSuspended("l.group_id", "d.day")})`;

/** As contas com acesso aos dados de cada aluno: o próprio (maior, com conta) ou o encarregado que o gere (menor). */
const RECIPIENTS = Prisma.sql`
  SELECT st.id AS student_id, st.account_id, NULL::date AS adult_from
    FROM students st WHERE st.account_id IS NOT NULL
  UNION
  SELECT sg.student_id, gu.account_id, (st.birth_date + interval '18 years')::date AS adult_from
    FROM student_guardians sg JOIN guardians gu ON gu.id = sg.guardian_id JOIN students st ON st.id = sg.student_id
   WHERE sg.can_manage AND gu.account_id IS NOT NULL`;

/** Resumos diários, na BD do colégio. Um por pessoa e por dia (índice único). */
export class PrismaDigestsRepository {
  constructor(private readonly db: PrismaClient) {}

  /** O colégio envia este tipo? (sem linha: os valores por omissão, dados por quem chama) */
  async types(kinds: string[]) {
    const r = await this.db.$queryRaw<{ kind: string; enabled: boolean; email: boolean }[]>`SELECT kind, enabled, email FROM notification_types WHERE kind = ANY(${kinds})`;
    return new Map(r.map((x) => [x.kind, { enabled: x.enabled, email: x.email }]));
  }

  /**
   * Professores e diretores de turma com resumo devido: a última aula prevista deles (ou das turmas
   * que coordenam) acabou há `delay` minutos ou mais (e há menos de `windowHours`), ainda sem resumo.
   */
  async dueStaff(days: string[], since: string, nowLocal: string, delay: number, windowHours: number, limit: number): Promise<DueStaff[]> {
    const r = await this.db.$queryRaw<{ user_id: string; full_name: string; employee_id: string; day: string; due_at: string }[]>`
      WITH planned AS (${PLANNED(days)}),
      who AS (
        SELECT day, teacher_id AS employee_id, day + ends_at AS ends FROM planned WHERE teacher_id IS NOT NULL
        UNION ALL
        SELECT day, coordinator_id, day + ends_at FROM planned WHERE coordinator_id IS NOT NULL
      ),
      due AS (SELECT day, employee_id, max(ends) + make_interval(mins => ${delay}::int) AS due_at FROM who WHERE day >= ${since}::date GROUP BY day, employee_id)
      SELECT u.id AS user_id, u.full_name, e.id AS employee_id, to_char(due.day, 'YYYY-MM-DD') AS day, to_char(due.due_at, 'YYYY-MM-DD HH24:MI') AS due_at
        FROM due JOIN employees e ON e.id = due.employee_id AND e.status IN ('APPROVED', 'ACTIVE') JOIN school_users u ON u.id = e.user_id AND u.status = 'ACTIVE'
       WHERE due.due_at <= ${nowLocal}::timestamp AND due.due_at > ${nowLocal}::timestamp - make_interval(hours => ${windowHours}::int)
         AND NOT EXISTS (SELECT 1 FROM daily_digests x WHERE x.audience = 'STAFF' AND x.recipient_id = u.id AND x.day = due.day)
       ORDER BY due.due_at LIMIT ${limit}`;
    return r.map((x) => ({ userId: x.user_id, fullName: x.full_name, employeeId: x.employee_id, day: x.day, dueAt: x.due_at }));
  }

  /**
   * Contas da família com resumo devido: 1 h depois da última aula dos alunos a que têm acesso. Só
   * quando já há alguma presença registada nesse dia (um resumo vazio não interessa a ninguém).
   */
  async dueFamily(days: string[], since: string, nowLocal: string, delay: number, windowHours: number, limit: number): Promise<DueFamily[]> {
    const r = await this.db.$queryRaw<{ account_id: string; full_name: string; email: string; day: string; due_at: string; students: string[] }[]>`
      WITH planned AS (${PLANNED(days)}),
      per_group AS (SELECT day, group_id, max(day + ends_at) AS ends FROM planned WHERE day >= ${since}::date GROUP BY day, group_id),
      rec AS (${RECIPIENTS}),
      per_student AS (
        SELECT pg.day, rec.account_id, en.student_id, pg.ends,
               EXISTS (SELECT 1 FROM student_attendance a JOIN lesson_sessions s ON s.id = a.session_id WHERE a.student_id = en.student_id AND s.group_id = pg.group_id AND s.day = pg.day) AS any_mark
          FROM per_group pg JOIN enrollments en ON en.group_id = pg.group_id AND en.status = 'ACTIVE'
          JOIN rec ON rec.student_id = en.student_id AND (rec.adult_from IS NULL OR pg.day < rec.adult_from)
      )
      SELECT fa.id AS account_id, fa.full_name, fa.email, to_char(ps.day, 'YYYY-MM-DD') AS day, to_char(max(ps.ends) + make_interval(mins => ${delay}::int), 'YYYY-MM-DD HH24:MI') AS due_at,
             array_agg(DISTINCT ps.student_id::text) AS students
        FROM per_student ps JOIN family_accounts fa ON fa.id = ps.account_id AND fa.status = 'ACTIVE'
       WHERE NOT EXISTS (SELECT 1 FROM daily_digests x WHERE x.audience = 'FAMILY' AND x.recipient_id = fa.id AND x.day = ps.day)
       GROUP BY fa.id, fa.full_name, fa.email, ps.day
      HAVING bool_or(ps.any_mark) AND max(ps.ends) + make_interval(mins => ${delay}::int) <= ${nowLocal}::timestamp
         AND max(ps.ends) + make_interval(mins => ${delay}::int) > ${nowLocal}::timestamp - make_interval(hours => ${windowHours}::int)
       ORDER BY max(ps.ends) LIMIT ${limit}`;
    return r.map((x) => ({ accountId: x.account_id, fullName: x.full_name, email: x.email, day: x.day, dueAt: x.due_at, studentIds: x.students }));
  }

  // ---------------------------------------------------------------- dados do dia

  async teacherLessons(employeeId: string, day: string): Promise<TeacherLesson[]> {
    const r = await this.db.$queryRaw<{ starts_at: string; ends_at: string; group_name: string; subject_name: string; substitution: boolean; session_id: string | null; late: boolean | null; has_summary: boolean; present: number; absent: number; late_n: number; justified: number; total: number }[]>`
      WITH planned AS (${PLANNED([day])})
      SELECT to_char(p.starts_at, 'HH24:MI') AS starts_at, to_char(p.ends_at, 'HH24:MI') AS ends_at, p.group_name, p.subject_name, p.substitution, p.session_id, p.late, (p.summary IS NOT NULL) AS has_summary,
             count(a.*) FILTER (WHERE a.status = 'PRESENTE')::int AS present, count(a.*) FILTER (WHERE a.status = 'AUSENTE')::int AS absent,
             count(a.*) FILTER (WHERE a.status = 'ATRASADO')::int AS late_n, count(a.*) FILTER (WHERE a.status = 'FALTA_JUSTIFICADA')::int AS justified, count(a.*)::int AS total
        FROM planned p LEFT JOIN student_attendance a ON a.session_id = p.session_id
       WHERE p.teacher_id = ${employeeId}::uuid
       GROUP BY p.starts_at, p.ends_at, p.group_id, p.group_name, p.subject_name, p.substitution, p.session_id, p.late, p.summary ORDER BY p.starts_at`;
    return r.map((x) => ({
      startsAt: x.starts_at,
      endsAt: x.ends_at,
      groupName: x.group_name,
      subjectName: x.subject_name,
      substitution: x.substitution,
      session: x.session_id ? { late: !!x.late, summary: x.has_summary, present: x.present, absent: x.absent, lateN: x.late_n, justified: x.justified, total: x.total } : null,
    }));
  }

  /** O dia de cada turma que o funcionário coordena (com aulas previstas nesse dia). */
  async coordinatedDays(employeeId: string, day: string, timeZone: string): Promise<GroupDay[]> {
    const lessons = await this.db.$queryRaw<{ group_id: string; group_name: string; starts_at: string; subject_name: string; teacher_name: string | null; registered: boolean }[]>`
      WITH planned AS (${PLANNED([day])})
      SELECT p.group_id, p.group_name, to_char(p.starts_at, 'HH24:MI') AS starts_at, p.subject_name, e.full_name AS teacher_name, (p.session_id IS NOT NULL) AS registered
        FROM planned p LEFT JOIN employees e ON e.id = p.teacher_id
       WHERE p.coordinator_id = ${employeeId}::uuid ORDER BY p.group_name, p.starts_at`;
    const ids = [...new Set(lessons.map((l) => l.group_id))];
    if (!ids.length) return [];
    const [marks, alerts] = await Promise.all([
      this.db.$queryRaw<{ group_id: string; student_id: string; full_name: string; status: PresenceStatus; minutes_late: number | null; subject_name: string }[]>`
        SELECT s.group_id, a.student_id, st.full_name, a.status, a.minutes_late, sub.name AS subject_name
          FROM lesson_sessions s JOIN student_attendance a ON a.session_id = s.id JOIN students st ON st.id = a.student_id JOIN subjects sub ON sub.id = s.subject_id
         WHERE s.group_id = ANY(${ids}::uuid[]) AND s.day = ${day}::date ORDER BY st.full_name, s.starts_at`,
      this.db.$queryRaw<{ group_id: string; full_name: string; rule: string; count: number }[]>`
        SELECT al.group_id, st.full_name, al.rule, al.count FROM attendance_alerts al JOIN students st ON st.id = al.student_id
         WHERE al.group_id = ANY(${ids}::uuid[]) AND (al.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date = ${day}::date ORDER BY al.created_at`,
    ]);
    // faltas seguidas de quem faltou hoje: bastam as últimas 40 marcas de cada um (o limite das regras é 30)
    const absent = [...new Set(marks.filter((m) => m.status === "AUSENTE").map((m) => m.student_id))];
    const recent = absent.length
      ? await this.db.$queryRaw<{ group_id: string; student_id: string; status: PresenceStatus }[]>`
          SELECT group_id, student_id, status FROM (
            SELECT s.group_id, a.student_id, a.status, row_number() OVER (PARTITION BY s.group_id, a.student_id ORDER BY s.day DESC, s.starts_at DESC) AS rn
              FROM student_attendance a JOIN lesson_sessions s ON s.id = a.session_id
             WHERE s.group_id = ANY(${ids}::uuid[]) AND a.student_id = ANY(${absent}::uuid[]) AND s.day <= ${day}::date) t
           WHERE rn <= 40 ORDER BY group_id, student_id, rn`
      : [];
    return ids.map((id) => {
      const streaks = new Map<string, number>();
      const closed = new Set<string>();
      for (const m of recent) {
        if (m.group_id !== id || closed.has(m.student_id)) continue;
        if (m.status === "AUSENTE") streaks.set(m.student_id, (streaks.get(m.student_id) ?? 0) + 1);
        else if (m.status !== "FALTA_JUSTIFICADA") closed.add(m.student_id);
      }
      const mine = lessons.filter((l) => l.group_id === id);
      return {
        groupName: mine[0].group_name,
        lessons: mine.map((l) => ({ startsAt: l.starts_at, subjectName: l.subject_name, teacherName: l.teacher_name, registered: l.registered })),
        marks: marks.filter((m) => m.group_id === id).map((m) => ({ studentId: m.student_id, fullName: m.full_name, status: m.status, minutesLate: m.minutes_late, subjectName: m.subject_name })),
        streaks,
        alerts: alerts.filter((a) => a.group_id === id).map((a) => ({ fullName: a.full_name, rule: a.rule, count: a.count })),
      };
    });
  }

  async studentDays(studentIds: string[], day: string): Promise<StudentDay[]> {
    const r = await this.db.$queryRaw<{ student_id: string; full_name: string; group_name: string; starts_at: string; subject_name: string; registered: boolean; status: PresenceStatus | null; minutes_late: number | null; summary: string | null }[]>`
      WITH planned AS (${PLANNED([day])})
      SELECT st.id AS student_id, st.full_name, p.group_name, to_char(p.starts_at, 'HH24:MI') AS starts_at, p.subject_name, (p.session_id IS NOT NULL) AS registered, a.status, a.minutes_late, p.summary
        FROM planned p JOIN enrollments en ON en.group_id = p.group_id AND en.status = 'ACTIVE' JOIN students st ON st.id = en.student_id
        LEFT JOIN student_attendance a ON a.session_id = p.session_id AND a.student_id = st.id
       WHERE st.id = ANY(${studentIds}::uuid[]) ORDER BY st.full_name, p.starts_at`;
    const out = new Map<string, StudentDay>();
    for (const x of r) {
      const s = out.get(x.student_id) ?? { studentId: x.student_id, fullName: x.full_name, groupName: x.group_name, lessons: [] };
      s.lessons.push({ startsAt: x.starts_at, subjectName: x.subject_name, registered: x.registered, status: x.status, minutesLate: x.minutes_late, summary: x.summary });
      out.set(x.student_id, s);
    }
    return [...out.values()];
  }

  /** Os outros avisos que a pessoa recebeu nesse dia, sem repetições (os alertas já estão na parte da turma). */
  async staffNotices(userId: string, day: string, timeZone: string): Promise<DayNotice[]> {
    return this.db.$queryRaw<DayNotice[]>`
      SELECT title, count(*)::int AS times FROM staff_notifications WHERE user_id = ${userId}::uuid AND kind NOT IN ('DAILY_DIGEST', 'ATTENDANCE_ALERT')
         AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date = ${day}::date GROUP BY title ORDER BY max(created_at) DESC LIMIT 8`;
  }

  async familyNotices(accountId: string, day: string, timeZone: string): Promise<DayNotice[]> {
    return this.db.$queryRaw<DayNotice[]>`
      SELECT title, count(*)::int AS times FROM family_notifications WHERE account_id = ${accountId}::uuid AND kind <> 'FAMILY_DAILY_DIGEST'
         AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE ${timeZone})::date = ${day}::date GROUP BY title ORDER BY max(created_at) DESC LIMIT 8`;
  }

  // ---------------------------------------------------------------- gravar

  /** Equipa: o aviso (com chave única) já foi entregue; fica o resumo. */
  async saveStaff(d: DueStaff, content: DigestContent, now: Date) {
    return this.db.$executeRaw`
      INSERT INTO daily_digests (id, audience, recipient_id, recipient_name, day, due_at, headline, content, created_at)
      VALUES (${randomUUID()}::uuid, 'STAFF', ${d.userId}::uuid, ${d.fullName}, ${d.day}::date, ${d.dueAt}::timestamp, ${content.headline}, ${JSON.stringify(content)}::jsonb, ${now})
      ON CONFLICT (audience, recipient_id, day) DO NOTHING`;
  }

  /** Família: o resumo e o aviso na mesma transação (ou ficam os dois, ou nenhum). false = já existia. */
  async saveFamily(d: DueFamily, content: DigestContent, email: boolean, notice: { kind: string; title: string; body: string; link: string }, now: Date) {
    return this.db.$transaction(async (tx) => {
      const made = await tx.$executeRaw`
        INSERT INTO daily_digests (id, audience, recipient_id, recipient_name, day, due_at, headline, content, email_state, created_at)
        VALUES (${randomUUID()}::uuid, 'FAMILY', ${d.accountId}::uuid, ${d.fullName}, ${d.day}::date, ${d.dueAt}::timestamp, ${content.headline}, ${JSON.stringify(content)}::jsonb, ${email ? "PENDING" : "NONE"}, ${now})
        ON CONFLICT (audience, recipient_id, day) DO NOTHING`;
      if (made !== 1) return false;
      await notifyFamily(tx, { accountId: d.accountId, ...notice, now });
      return true;
    });
  }

  // ---------------------------------------------------------------- email da família (com novas tentativas)

  async pendingEmails(now: Date) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM daily_digests WHERE email_state = 'PENDING' AND email_attempts < 3 AND created_at + make_interval(mins => email_attempts * 10) <= ${now}::timestamp AND created_at > ${now}::timestamp - interval '1 day'`;
    return r?.n ?? 0;
  }

  /** Reserva os emails por enviar (cada tentativa conta; outra instância não pega nos mesmos). */
  async claimEmails(now: Date, limit: number) {
    return this.db.$queryRaw<{ id: string; account_id: string; full_name: string; email: string; day: string; headline: string; content: DigestContent; attempts: number }[]>`
      WITH pick AS (
        SELECT id FROM daily_digests
         WHERE email_state = 'PENDING' AND email_attempts < 3 AND created_at + make_interval(mins => email_attempts * 10) <= ${now}::timestamp AND created_at > ${now}::timestamp - interval '1 day'
         ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED),
      up AS (UPDATE daily_digests d SET email_attempts = d.email_attempts + 1 FROM pick WHERE d.id = pick.id RETURNING d.*)
      SELECT up.id, a.id AS account_id, a.full_name, a.email, to_char(up.day, 'YYYY-MM-DD') AS day, up.headline, up.content, up.email_attempts AS attempts
        FROM up JOIN family_accounts a ON a.id = up.recipient_id`;
  }

  async emailResult(id: string, state: "SENT" | "PENDING" | "FAILED") {
    await this.db.$executeRaw`UPDATE daily_digests SET email_state = ${state} WHERE id = ${id}::uuid`;
  }

  async logFamilyEmail(e: { accountId: string; fullName: string; kind: string; title: string; destination: string | null; status: "SENT" | "FAILED" | "SKIPPED"; error: string | null; now: Date }) {
    await this.db.$executeRaw`
      INSERT INTO notification_deliveries (id, audience, notification_id, recipient_id, recipient_name, kind, title, channel, destination, status, error, created_at)
      VALUES (${randomUUID()}::uuid, 'FAMILY', NULL, ${e.accountId}::uuid, ${e.fullName}, ${e.kind}, ${e.title.slice(0, 200)}, 'EMAIL', ${e.destination}, ${e.status}, ${e.error}, ${e.now})`;
  }

  async familyPreferences(accountId: string) {
    const r = await this.db.$queryRaw<{ kind: string; email: boolean }[]>`SELECT kind, email FROM family_notification_preferences WHERE account_id = ${accountId}::uuid`;
    return new Map(r.map((x) => [x.kind, x.email]));
  }

  async setFamilyPreference(accountId: string, kind: string, email: boolean, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO family_notification_preferences (account_id, kind, email, updated_at) VALUES (${accountId}::uuid, ${kind}, ${email}, ${now})
      ON CONFLICT (account_id, kind) DO UPDATE SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at`;
  }

  // ---------------------------------------------------------------- ler

  async list(audience: "STAFF" | "FAMILY", recipientId: string, limit: number): Promise<DigestRow[]> {
    const r = await this.db.$queryRaw<{ day: string; due_at: string; headline: string; content: DigestContent; created_at: Date }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, to_char(due_at, 'YYYY-MM-DD HH24:MI') AS due_at, headline, content, created_at FROM daily_digests
       WHERE audience = ${audience} AND recipient_id = ${recipientId}::uuid ORDER BY day DESC LIMIT ${limit}`;
    return r.map((x) => ({ day: x.day, dueAt: x.due_at, headline: x.headline, content: x.content, createdAt: x.created_at }));
  }

  /** Os alunos a que a conta tem acesso HOJE (um resumo antigo não mostra quem já não gere). */
  async accessibleStudents(accountId: string, today: string) {
    const r = await this.db.$queryRaw<{ student_id: string }[]>`
      SELECT student_id FROM (${RECIPIENTS}) rec WHERE rec.account_id = ${accountId}::uuid AND (rec.adult_from IS NULL OR ${today}::date < rec.adult_from)`;
    return new Set(r.map((x) => x.student_id));
  }

  /** Contagens para a direção: resumos por dia (últimos 14) e emails da família. */
  async stats() {
    return this.db.$queryRaw<{ day: string; staff: number; family: number; emails: number; email_failed: number }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, count(*) FILTER (WHERE audience = 'STAFF')::int AS staff, count(*) FILTER (WHERE audience = 'FAMILY')::int AS family,
             count(*) FILTER (WHERE email_state = 'SENT')::int AS emails, count(*) FILTER (WHERE email_state = 'FAILED')::int AS email_failed
        FROM daily_digests GROUP BY day ORDER BY day DESC LIMIT 14`;
  }
}
