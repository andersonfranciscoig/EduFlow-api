import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { lessonsSuspended } from "../../exams/infrastructure/exam-break";

export interface NewPending {
  id: string;
  lessonId: string | null;
  teacherId: string;
  teacherName: string;
  groupName: string;
  subjectName: string;
  day: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Tarefas automáticas da assiduidade, na BD do colégio. Cada passo é idempotente: repetir
 * (ou correr em duas instâncias) não cria nada duas vezes — os índices únicos garantem-no.
 */
export class PrismaDeadlineRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Começa uma execução, se não houver outra a correr (há menos de 10 min). null = já há uma. */
  async begin(job: string, trigger: "SCHEDULER" | "MANUAL", now: Date): Promise<string | null> {
    const id = randomUUID();
    const [, inserted] = await this.db.$transaction([
      this.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`job:${job}`}))`,
      this.db.$executeRaw`
        INSERT INTO job_runs (id, job, trigger, status, started_at)
        SELECT ${id}::uuid, ${job}, ${trigger}, 'RUNNING', ${now}
         WHERE NOT EXISTS (SELECT 1 FROM job_runs WHERE job = ${job} AND status = 'RUNNING' AND started_at > ${now}::timestamp - interval '10 minutes')`,
    ]);
    return inserted === 1 ? id : null;
  }

  async finish(id: string, status: "DONE" | "FAILED", stats: Record<string, unknown> | null, error: string | null, now: Date) {
    await this.db.$executeRaw`UPDATE job_runs SET status = ${status}, stats = ${stats ? JSON.stringify(stats) : null}::jsonb, error = ${error}, finished_at = ${now} WHERE id = ${id}::uuid`;
    // guarda só as últimas 500 execuções de cada tarefa
    await this.db.$executeRaw`DELETE FROM job_runs WHERE job = (SELECT job FROM job_runs WHERE id = ${id}::uuid)
                                AND id NOT IN (SELECT id FROM job_runs j WHERE j.job = (SELECT job FROM job_runs WHERE id = ${id}::uuid) ORDER BY started_at DESC LIMIT 500)`;
  }

  async runs(job: string, limit: number) {
    return this.db.$queryRaw<{ id: string; trigger: string; status: string; stats: Record<string, number> | null; error: string | null; started_at: Date; finished_at: Date | null }[]>`
      SELECT id, trigger, status, stats, error, started_at, finished_at FROM job_runs WHERE job = ${job} ORDER BY started_at DESC LIMIT ${limit}`;
  }

  /**
   * Aulas do horário (com professor — o titular, ou o substituto desse dia) cujo prazo já passou,
   * em dias de aulas desde `from`, sem presenças submetidas e ainda sem pendência: cria-as.
   */
  async createPendings(from: string, today: string, nowLocal: string, deadlineMinutes: number, now: Date): Promise<NewPending[]> {
    const rows = await this.db.$queryRaw<{ id: string; lesson_id: string | null; teacher_id: string; teacher_name: string; group_name: string; subject_name: string; day: string; starts_at: string; ends_at: string }[]>`
      WITH days AS (SELECT d::date AS day FROM generate_series(${from}::date, ${today}::date, interval '1 day') d WHERE extract(isodow FROM d) <= 6),
      due AS (
        SELECT l.id AS lesson_id, l.academic_year_id, l.group_id, l.subject_id, coalesce(sub.substitute_id, l.teacher_id) AS teacher_id,
               g.name AS group_name, s.name AS subject_name, d.day,
               date_trunc('minute', p.starts_at::interval)::time AS starts_at, date_trunc('minute', p.ends_at::interval)::time AS ends_at
          FROM days d
          JOIN lessons l ON l.weekday = extract(isodow FROM d.day)::int
          JOIN academic_years y ON y.id = l.academic_year_id AND y.status <> 'CLOSED' AND d.day BETWEEN y.starts_on AND y.ends_on
          JOIN school_periods p ON p.id = l.period_id
          JOIN class_groups g ON g.id = l.group_id
          JOIN subjects s ON s.id = l.subject_id
          LEFT JOIN lesson_substitutions sub ON sub.lesson_id = l.id AND sub.day = d.day
         WHERE coalesce(sub.substitute_id, l.teacher_id) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM school_closures c WHERE c.academic_year_id = y.id AND d.day BETWEEN c.starts_on AND c.ends_on)
           AND NOT ${lessonsSuspended("l.group_id", "d.day")}
           AND (d.day + p.ends_at + make_interval(mins => ${deadlineMinutes}::int)) <= ${nowLocal}::timestamp
           AND NOT EXISTS (SELECT 1 FROM lesson_sessions ss WHERE ss.group_id = l.group_id AND ss.day = d.day AND ss.starts_at = date_trunc('minute', p.starts_at::interval)::time)
      ),
      ins AS (
        INSERT INTO lesson_pendings (id, lesson_id, academic_year_id, group_id, subject_id, teacher_id, group_name, subject_name, day, starts_at, ends_at, status, created_at)
        SELECT gen_random_uuid(), lesson_id, academic_year_id, group_id, subject_id, teacher_id, group_name, subject_name, day, starts_at, ends_at, 'OPEN', ${now} FROM due
        ON CONFLICT (group_id, day, starts_at) DO NOTHING
        RETURNING id, lesson_id, teacher_id, group_name, subject_name, day, starts_at, ends_at
      )
      SELECT ins.id, ins.lesson_id, ins.teacher_id, e.full_name AS teacher_name, ins.group_name, ins.subject_name, to_char(ins.day, 'YYYY-MM-DD') AS day,
             to_char(ins.starts_at, 'HH24:MI') AS starts_at, to_char(ins.ends_at, 'HH24:MI') AS ends_at
        FROM ins JOIN employees e ON e.id = ins.teacher_id
       ORDER BY ins.day, ins.starts_at`;
    return rows.map((r) => ({ id: r.id, lessonId: r.lesson_id, teacherId: r.teacher_id, teacherName: r.teacher_name, groupName: r.group_name, subjectName: r.subject_name, day: r.day, startsAt: r.starts_at, endsAt: r.ends_at }));
  }

  /** Falta automática a uma aula (só se o professor ainda não tiver nenhuma ocorrência — nem anulada — nessa aula). */
  async autoLessonOccurrence(p: NewPending, note: string, now: Date): Promise<string | null> {
    const id = randomUUID();
    const r = await this.db.$executeRaw`
      INSERT INTO teacher_occurrences (id, employee_id, day, scope, lesson_id, group_name, subject_name, starts_at, ends_at, kind, source, status, note, created_at, updated_at)
      SELECT ${id}::uuid, ${p.teacherId}::uuid, ${p.day}::date, 'LESSON', ${p.lessonId}::uuid, ${p.groupName}, ${p.subjectName}, ${p.startsAt}::time, ${p.endsAt}::time, 'FALTA', 'AUTOMATIC', 'REGISTADA', ${note}, ${now}, ${now}
       WHERE NOT EXISTS (SELECT 1 FROM teacher_occurrences o WHERE o.employee_id = ${p.teacherId}::uuid AND o.day = ${p.day}::date AND o.scope = 'LESSON' AND o.starts_at = ${p.startsAt}::time)
      ON CONFLICT DO NOTHING`;
    if (r !== 1) return null;
    await this.db.$executeRaw`UPDATE lesson_pendings SET status = 'FAULT', occurrence_id = ${id}::uuid, decided_at = ${now} WHERE id = ${p.id}::uuid AND status = 'OPEN'`;
    return id;
  }

  /**
   * Modelo "por dia": os dias de cada professor já fechados (o prazo da última aula passou), desde `from`,
   * que ainda não têm registo diário no RH nem ocorrência do dia. submitted = submeteu pelo menos uma aula.
   */
  async teacherDaysToEvaluate(from: string, today: string, nowLocal: string, deadlineMinutes: number) {
    return this.db.$queryRaw<{ teacher_id: string; teacher_name: string; day: string; submitted: boolean; lessons: number }[]>`
      WITH days AS (SELECT d::date AS day FROM generate_series(${from}::date, ${today}::date, interval '1 day') d WHERE extract(isodow FROM d) <= 6),
      planned AS (
        SELECT coalesce(sub.substitute_id, l.teacher_id) AS teacher_id, d.day, l.group_id, date_trunc('minute', p.starts_at::interval)::time AS starts_at, p.ends_at
          FROM days d
          JOIN lessons l ON l.weekday = extract(isodow FROM d.day)::int
          JOIN academic_years y ON y.id = l.academic_year_id AND y.status <> 'CLOSED' AND d.day BETWEEN y.starts_on AND y.ends_on
          JOIN school_periods p ON p.id = l.period_id
          LEFT JOIN lesson_substitutions sub ON sub.lesson_id = l.id AND sub.day = d.day
         WHERE coalesce(sub.substitute_id, l.teacher_id) IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM school_closures c WHERE c.academic_year_id = y.id AND d.day BETWEEN c.starts_on AND c.ends_on)
           AND (NOT ${lessonsSuspended("l.group_id", "d.day")} OR EXISTS (SELECT 1 FROM lesson_sessions sx WHERE sx.group_id = l.group_id AND sx.day = d.day AND sx.starts_at = date_trunc('minute', p.starts_at::interval)::time))
      )
      SELECT pl.teacher_id, e.full_name AS teacher_name, to_char(pl.day, 'YYYY-MM-DD') AS day, count(*)::int AS lessons,
             bool_or(EXISTS (SELECT 1 FROM lesson_sessions ss WHERE ss.group_id = pl.group_id AND ss.day = pl.day AND ss.starts_at = pl.starts_at)) AS submitted
        FROM planned pl JOIN employees e ON e.id = pl.teacher_id
       WHERE NOT EXISTS (SELECT 1 FROM employee_attendance ea WHERE ea.employee_id = pl.teacher_id AND ea.day = pl.day)
         AND NOT EXISTS (SELECT 1 FROM teacher_occurrences o WHERE o.employee_id = pl.teacher_id AND o.day = pl.day AND o.scope = 'DAY')
       GROUP BY pl.teacher_id, e.full_name, pl.day
      HAVING max(pl.day + pl.ends_at + make_interval(mins => ${deadlineMinutes}::int)) <= ${nowLocal}::timestamp
       ORDER BY pl.day`;
  }

  /** Dia com presenças submetidas: presente (se o RH ainda não marcou nada nesse dia). */
  async dailyPresent(teacherId: string, day: string, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO employee_attendance (id, employee_id, day, status, note, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${teacherId}::uuid, ${day}::date, 'PRESENTE', 'Automático: presenças submetidas', ${now}, ${now})
      ON CONFLICT (employee_id, day) DO NOTHING`;
  }

  /** Dia sem nenhuma presença submetida, gestão automática: falta do dia (e o registo diário do RH). */
  async autoDayOccurrence(teacherId: string, day: string, note: string, now: Date): Promise<string | null> {
    const id = randomUUID();
    const r = await this.db.$executeRaw`
      INSERT INTO teacher_occurrences (id, employee_id, day, scope, kind, source, status, note, created_at, updated_at)
      SELECT ${id}::uuid, ${teacherId}::uuid, ${day}::date, 'DAY', 'FALTA', 'AUTOMATIC', 'REGISTADA', ${note}, ${now}, ${now}
       WHERE NOT EXISTS (SELECT 1 FROM teacher_occurrences o WHERE o.employee_id = ${teacherId}::uuid AND o.day = ${day}::date AND o.scope = 'DAY')
      ON CONFLICT DO NOTHING`;
    if (r !== 1) return null;
    await this.db.$executeRaw`
      INSERT INTO employee_attendance (id, employee_id, day, status, note, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${teacherId}::uuid, ${day}::date, 'FALTA', NULL, ${now}, ${now})
      ON CONFLICT (employee_id, day) DO NOTHING`;
    await this.db.$executeRaw`UPDATE lesson_pendings SET status = 'FAULT', occurrence_id = ${id}::uuid, decided_at = ${now} WHERE teacher_id = ${teacherId}::uuid AND day = ${day}::date AND status = 'OPEN'`;
    return id;
  }

  /** Quem trata das pendências: o responsável e quem tem "Gerir as faltas dos professores". */
  async hrUserIds(): Promise<string[]> {
    const r = await this.db.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM school_users u
       WHERE u.status = 'ACTIVE' AND (u.is_owner OR EXISTS (SELECT 1 FROM school_user_permissions p WHERE p.user_id = u.id AND p.permission = 'attendance.teachers.manage'))`;
    return r.map((x) => x.id);
  }

  async record(type: string, subjectId: string, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId: null, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
