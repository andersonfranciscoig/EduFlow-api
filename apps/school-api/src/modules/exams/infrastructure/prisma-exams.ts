import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { type ExamCtx, type ExamFormat, groupLabel, type YearCtx } from "../domain/exams";

export interface YearRow {
  id: string;
  name: string;
  status: string;
  startsOn: string;
  endsOn: string;
  periodKind: string;
}
export interface NewExam {
  id: string;
  seasonId: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  day: string;
  startsAt: string;
  endsAt: string;
  room: string | null;
  format: ExamFormat;
  notes: string | null;
}
export interface NewNotice {
  seasonId: string;
  groupIds: string[];
  subjectId: string | null;
  teacherIds: string[];
  title: string;
  body: string;
}
export interface NoticeRow {
  id: string;
  season_id: string;
  group_ids: string[];
  subject_id: string | null;
  teacher_ids: string[];
  title: string;
  body: string;
  family_sent: boolean;
  staff_sent: boolean;
}
/** Uma prova tal como a veem os professores e as famílias. */
export interface PublicExam extends ExamCtx {
  seasonName: string;
  groupLabel: string;
  groupRoom: string | null;
  interrupts: boolean;
}

type Db = PrismaClient | Prisma.TransactionClient;
const EXAM = Prisma.raw(`
  e.id, e.season_id AS "seasonId", e.group_id AS "groupId", e.subject_id AS "subjectId", su.name AS "subjectName", su.color AS "subjectColor", e.teacher_id AS "teacherId", t.full_name AS "teacherName",
  to_char(e.day, 'YYYY-MM-DD') AS day, to_char(e.starts_at, 'HH24:MI') AS "startsAt", to_char(e.ends_at, 'HH24:MI') AS "endsAt", e.room, e.format, e.notes, e.status, e.cancel_reason AS "cancelReason", e.updated_at AS "updatedAt"`);
const isUnique = (e: unknown) => {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return e.code === "P2002" || (e.meta as { code?: string } | undefined)?.code === "23505";
};

/** Calendário de provas, na BD do colégio. */
export class PrismaExamsRepository {
  constructor(
    private readonly db: Db,
    private readonly root: PrismaClient | null = null,
  ) {}

  static for(db: PrismaClient) {
    return new PrismaExamsRepository(db, db);
  }

  /**
   * Alterações às provas de um ano: uma de cada vez (bloqueio na BD), para que a verificação dos
   * conflitos e a gravação vejam sempre as mesmas provas.
   */
  async locked<T>(yearId: string, work: (repo: PrismaExamsRepository) => Promise<T>): Promise<T> {
    if (!this.root) throw new Error("já está numa transação");
    return this.root.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`exams:${yearId}`}))`;
      return work(new PrismaExamsRepository(tx));
    });
  }

  /** null quando a prova já existe (mesma turma, disciplina e modalidade na época). */
  async uniqueOr<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (e) {
      if (isUnique(e)) return null;
      throw e;
    }
  }

  async years(): Promise<YearRow[]> {
    return this.db.$queryRaw<YearRow[]>`
      SELECT id, name, status, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn", period_kind AS "periodKind"
        FROM academic_years ORDER BY starts_on DESC`;
  }

  async periods(yearId: string) {
    return this.db.$queryRaw<{ position: number; startsOn: string; endsOn: string }[]>`
      SELECT position, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM academic_periods WHERE academic_year_id = ${yearId}::uuid ORDER BY position`;
  }

  async yearOfSeason(seasonId: string) {
    const r = await this.db.$queryRaw<{ year_id: string }[]>`SELECT academic_year_id AS year_id FROM exam_seasons WHERE id = ${seasonId}::uuid`;
    return r[0]?.year_id ?? null;
  }

  async seasonOfExam(examId: string) {
    const r = await this.db.$queryRaw<{ season_id: string; year_id: string }[]>`
      SELECT e.season_id, s.academic_year_id AS year_id FROM exams e JOIN exam_seasons s ON s.id = e.season_id WHERE e.id = ${examId}::uuid`;
    return r[0] ? { seasonId: r[0].season_id, yearId: r[0].year_id } : null;
  }

  /** Tudo o que conta para as provas de um ano, numa só ida à BD. */
  async context(yearId: string): Promise<YearCtx | null> {
    const r = await this.db.$queryRaw<{ data: Omit<YearCtx, "groups"> & { groups: (Omit<YearCtx["groups"][number], "label"> & { courseCode: string | null })[] } }[]>`
      SELECT json_build_object(
        'year', json_build_object('id', y.id, 'name', y.name, 'status', y.status, 'startsOn', to_char(y.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(y.ends_on, 'YYYY-MM-DD'), 'periodKind', y.period_kind),
        'seasons', (SELECT coalesce(json_agg(json_build_object(
            'id', s.id, 'name', s.name, 'periodPosition', s.period_position, 'position', s.position, 'startsOn', to_char(s.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(s.ends_on, 'YYYY-MM-DD'),
            'interrupts', s.interrupts, 'format', s.format, 'notes', s.notes, 'status', s.status, 'publishedAt', to_char(s.published_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'groupIds', (SELECT coalesce(json_agg(sg.group_id), '[]'::json) FROM exam_season_groups sg WHERE sg.season_id = s.id),
            'subjects', (SELECT coalesce(json_agg(json_build_object('classId', ss.class_id, 'subjectId', ss.subject_id)), '[]'::json) FROM exam_season_subjects ss WHERE ss.season_id = s.id)
          ) ORDER BY s.period_position, s.position, s.created_at), '[]'::json) FROM exam_seasons s WHERE s.academic_year_id = y.id),
        'groups', (SELECT coalesce(json_agg(json_build_object('id', g.id, 'name', g.name, 'classId', g.class_id, 'grade', c.grade, 'courseId', c.course_id, 'courseName', co.name, 'courseCode', co.code, 'shift', g.shift, 'room', g.room, 'coordinatorId', g.coordinator_id)
            ORDER BY c.grade, co.name, g.name), '[]'::json) FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id WHERE g.academic_year_id = y.id),
        'exams', (SELECT coalesce(json_agg(x ORDER BY x.day, x."startsAt", x."subjectName"), '[]'::json) FROM (
            SELECT ${EXAM} FROM exams e JOIN exam_seasons s2 ON s2.id = e.season_id JOIN subjects su ON su.id = e.subject_id LEFT JOIN employees t ON t.id = e.teacher_id WHERE s2.academic_year_id = y.id) x),
        'lessons', (SELECT coalesce(json_agg(json_build_object('groupId', l.group_id, 'subjectId', l.subject_id, 'subjectName', su.name, 'teacherId', l.teacher_id, 'weekday', l.weekday,
            'startsAt', to_char(p.starts_at, 'HH24:MI'), 'endsAt', to_char(p.ends_at, 'HH24:MI'))), '[]'::json)
            FROM lessons l JOIN school_periods p ON p.id = l.period_id JOIN subjects su ON su.id = l.subject_id WHERE l.academic_year_id = y.id),
        'closures', (SELECT coalesce(json_agg(json_build_object('startsOn', to_char(c.starts_on, 'YYYY-MM-DD'), 'endsOn', to_char(c.ends_on, 'YYYY-MM-DD'), 'reason', c.reason) ORDER BY c.starts_on), '[]'::json) FROM school_closures c WHERE c.academic_year_id = y.id),
        'shifts', (SELECT coalesce(json_agg(json_build_object('shift', z.shift, 'startsAt', z.s, 'endsAt', z.e)), '[]'::json)
            FROM (SELECT shift, to_char(min(starts_at), 'HH24:MI') AS s, to_char(max(ends_at), 'HH24:MI') AS e FROM school_periods GROUP BY shift) z)
      ) AS data FROM academic_years y WHERE y.id = ${yearId}::uuid`;
    const d = r[0]?.data;
    return d ? { ...d, groups: d.groups.map(({ courseCode, ...g }) => ({ ...g, label: groupLabel({ name: g.name, grade: g.grade, courseCode }) })) } : null;
  }

  /** O que se pode escolher numa época: plano curricular por classe, professor de cada disciplina e turma, professores e tempos. */
  async choices(yearId: string) {
    const r = await this.db.$queryRaw<
      {
        data: {
          plan: { classId: string; subjectId: string; name: string; code: string; color: string }[];
          groupTeachers: { groupId: string; subjectId: string; employeeId: string }[];
          teachers: { id: string; fullName: string }[];
          slots: { shift: string; startsAt: string; endsAt: string }[];
        };
      }[]
    >`
      SELECT json_build_object(
        'plan', (SELECT coalesce(json_agg(json_build_object('classId', cs.class_id, 'subjectId', s.id, 'name', s.name, 'code', s.code, 'color', s.color) ORDER BY cs.position, s.name), '[]'::json)
                   FROM class_subjects cs JOIN subjects s ON s.id = cs.subject_id WHERE cs.academic_year_id = ${yearId}::uuid),
        'groupTeachers', (SELECT coalesce(json_agg(json_build_object('groupId', gt.group_id, 'subjectId', gt.subject_id, 'employeeId', gt.employee_id)), '[]'::json)
                   FROM group_teachers gt JOIN class_groups g ON g.id = gt.group_id JOIN employees e ON e.id = gt.employee_id AND e.status IN ('APPROVED', 'ACTIVE') WHERE g.academic_year_id = ${yearId}::uuid),
        'teachers', (SELECT coalesce(json_agg(json_build_object('id', e.id, 'fullName', e.full_name) ORDER BY e.full_name), '[]'::json) FROM employees e
                  WHERE e.status IN ('APPROVED', 'ACTIVE') AND (EXISTS (SELECT 1 FROM group_teachers gt WHERE gt.employee_id = e.id) OR EXISTS (SELECT 1 FROM teacher_qualifications q WHERE q.employee_id = e.id)
                        OR EXISTS (SELECT 1 FROM school_users u WHERE u.id = e.user_id AND u.role = 'PROFESSOR'))),
        'slots', (SELECT coalesce(json_agg(json_build_object('shift', p.shift, 'startsAt', to_char(p.starts_at, 'HH24:MI'), 'endsAt', to_char(p.ends_at, 'HH24:MI')) ORDER BY p.shift, p.starts_at), '[]'::json)
                   FROM school_periods p WHERE p.kind = 'AULA')
      ) AS data`;
    return r[0].data;
  }

  // ------------------------------------------------------------------ modelo

  /** Acrescenta, muda o nome/ordem e retira as épocas de um período. */
  async saveModel(yearId: string, position: number, items: { id: string | null; name: string }[], remove: string[], actorId: string | null, now: Date) {
    if (remove.length) await this.db.$executeRaw`DELETE FROM exam_seasons WHERE id = ANY(${remove}::uuid[])`;
    const rows = items.map((it, i) => ({ id: it.id ?? randomUUID(), name: it.name, position: i + 1 }));
    if (!rows.length) return;
    await this.db.$executeRaw`
      INSERT INTO exam_seasons (id, academic_year_id, period_position, position, name, created_by_id, created_at, updated_at)
      SELECT x.id, ${yearId}::uuid, ${position}::int, x.position, x.name, ${actorId}::uuid, ${now}::timestamp, ${now}::timestamp
        FROM json_to_recordset(${JSON.stringify(rows)}::json) AS x(id uuid, name text, position int)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at`;
  }

  async configure(id: string, c: { startsOn: string; endsOn: string; interrupts: boolean; format: ExamFormat; notes: string | null; groupIds: string[]; subjects: { classId: string; subjectId: string }[] }, now: Date) {
    await this.db.$executeRaw`UPDATE exam_seasons SET starts_on = ${c.startsOn}::date, ends_on = ${c.endsOn}::date, interrupts = ${c.interrupts}, format = ${c.format}, notes = ${c.notes}, updated_at = ${now} WHERE id = ${id}::uuid`;
    await this.db.$executeRaw`DELETE FROM exam_season_groups WHERE season_id = ${id}::uuid AND NOT (group_id = ANY(${c.groupIds}::uuid[]))`;
    await this.db.$executeRaw`INSERT INTO exam_season_groups (season_id, group_id) SELECT ${id}::uuid, g FROM unnest(${c.groupIds}::uuid[]) g ON CONFLICT DO NOTHING`;
    await this.db.$executeRaw`DELETE FROM exam_season_subjects WHERE season_id = ${id}::uuid`;
    await this.db.$executeRaw`
      INSERT INTO exam_season_subjects (season_id, class_id, subject_id)
      SELECT ${id}::uuid, x."classId", x."subjectId" FROM json_to_recordset(${JSON.stringify(c.subjects)}::json) AS x("classId" uuid, "subjectId" uuid) ON CONFLICT DO NOTHING`;
  }

  async setStatus(id: string, status: "DRAFT" | "PUBLISHED", actorId: string | null, now: Date) {
    await this.db.$executeRaw`
      UPDATE exam_seasons SET status = ${status}, published_at = ${status === "PUBLISHED" ? now : null}::timestamp, published_by_id = ${status === "PUBLISHED" ? actorId : null}::uuid, updated_at = ${now} WHERE id = ${id}::uuid`;
  }

  async extend(id: string, endsOn: string, now: Date) {
    await this.db.$executeRaw`UPDATE exam_seasons SET ends_on = ${endsOn}::date, updated_at = ${now} WHERE id = ${id}::uuid`;
  }

  // ------------------------------------------------------------------ provas

  async insert(list: NewExam[], actorId: string | null, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO exams (id, season_id, group_id, subject_id, teacher_id, day, starts_at, ends_at, room, format, notes, status, created_by_id, created_at, updated_by_id, updated_at)
      SELECT x.id, x."seasonId", x."groupId", x."subjectId", x."teacherId", x.day, x."startsAt", x."endsAt", x.room, x.format, x.notes, 'SCHEDULED', ${actorId}::uuid, ${now}::timestamp, ${actorId}::uuid, ${now}::timestamp
        FROM json_to_recordset(${JSON.stringify(list)}::json) AS x(id uuid, "seasonId" uuid, "groupId" uuid, "subjectId" uuid, "teacherId" uuid, day date, "startsAt" time, "endsAt" time, room text, format text, notes text)`;
  }

  async update(id: string, e: Omit<NewExam, "id" | "seasonId" | "groupId" | "subjectId">, actorId: string | null, now: Date) {
    await this.db.$executeRaw`
      UPDATE exams SET teacher_id = ${e.teacherId}::uuid, day = ${e.day}::date, starts_at = ${e.startsAt}::time, ends_at = ${e.endsAt}::time, room = ${e.room}, format = ${e.format}, notes = ${e.notes},
             updated_by_id = ${actorId}::uuid, updated_at = ${now} WHERE id = ${id}::uuid`;
  }

  async remove(id: string) {
    await this.db.$executeRaw`DELETE FROM exams WHERE id = ${id}::uuid`;
  }

  async cancel(id: string, reason: string, actorId: string | null, now: Date) {
    await this.db.$executeRaw`UPDATE exams SET status = 'CANCELLED', cancel_reason = ${reason}, updated_by_id = ${actorId}::uuid, updated_at = ${now} WHERE id = ${id}::uuid`;
  }

  // ------------------------------------------------------------------ histórico e avisos

  async record(type: string, seasonId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId: seasonId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  async history(seasonId: string, limit: number) {
    return this.db.$queryRaw<{ at: Date; type: string; by: string | null; details: Record<string, unknown> | null }[]>`
      SELECT a.occurred_at AS at, a.type, u.full_name AS by, a.details FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id
       WHERE a.subject_id = ${seasonId}::uuid ORDER BY a.occurred_at DESC LIMIT ${limit}`;
  }

  async addNotice(n: NewNotice, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO exam_notices (id, season_id, group_ids, subject_id, teacher_ids, title, body, created_at)
      VALUES (${randomUUID()}::uuid, ${n.seasonId}::uuid, ${n.groupIds}::uuid[], ${n.subjectId}::uuid, ${n.teacherIds}::uuid[], ${n.title.slice(0, 180)}, ${n.body.slice(0, 900)}, ${now})`;
  }

  /** Reserva os avisos por entregar (outra instância não pega nos mesmos; um que fique a meio volta 5 min depois). */
  async claimNotices(now: Date): Promise<NoticeRow[]> {
    const r = await this.db.$queryRaw<NoticeRow[]>`
      WITH pick AS (
        SELECT id FROM exam_notices
         WHERE (family_sent_at IS NULL OR staff_sent_at IS NULL) AND attempts < 5 AND (claimed_at IS NULL OR claimed_at < ${now}::timestamp - interval '5 minutes')
         ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED),
      up AS (UPDATE exam_notices n SET claimed_at = ${now}::timestamp, attempts = n.attempts + 1 FROM pick WHERE n.id = pick.id RETURNING n.*)
      SELECT id, season_id, group_ids, subject_id, teacher_ids, title, body, family_sent_at IS NOT NULL AS family_sent, staff_sent_at IS NOT NULL AS staff_sent FROM up ORDER BY created_at`;
    return r;
  }

  async pendingNotices(now: Date) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM exam_notices WHERE (family_sent_at IS NULL OR staff_sent_at IS NULL) AND attempts < 5 AND (claimed_at IS NULL OR claimed_at < ${now}::timestamp - interval '5 minutes')`;
    return r?.n ?? 0;
  }

  async noticeError(id: string, error: string) {
    await this.db.$executeRaw`UPDATE exam_notices SET error = ${error.slice(0, 300)} WHERE id = ${id}::uuid`;
  }

  async staffSent(id: string, now: Date) {
    await this.db.$executeRaw`UPDATE exam_notices SET staff_sent_at = ${now} WHERE id = ${id}::uuid`;
  }

  /** Professores a avisar: das disciplinas nas turmas, os responsáveis pelas provas e os diretores de turma. */
  async noticeEmployees(n: Pick<NoticeRow, "season_id" | "group_ids" | "subject_id" | "teacher_ids">) {
    const r = await this.db.$queryRaw<{ id: string }[]>`
      SELECT employee_id AS id FROM group_teachers gt JOIN class_groups g ON g.id = gt.group_id
       WHERE gt.group_id = ANY(${n.group_ids}::uuid[]) AND (${n.subject_id}::uuid IS NULL OR gt.subject_id = ${n.subject_id}::uuid)
         AND EXISTS (SELECT 1 FROM exam_season_subjects ss WHERE ss.season_id = ${n.season_id}::uuid AND ss.class_id = g.class_id AND ss.subject_id = gt.subject_id)
      UNION SELECT coordinator_id FROM class_groups WHERE id = ANY(${n.group_ids}::uuid[]) AND coordinator_id IS NOT NULL
      UNION SELECT teacher_id FROM exams WHERE season_id = ${n.season_id}::uuid AND group_id = ANY(${n.group_ids}::uuid[]) AND teacher_id IS NOT NULL AND status = 'SCHEDULED' AND ${n.subject_id}::uuid IS NULL
      UNION SELECT unnest(${n.teacher_ids}::uuid[])`;
    return r.map((x) => x.id);
  }

  /**
   * Entrega às famílias numa só instrução (uma vez: o aviso fica marcado na mesma instrução).
   * Recebe quem tem acesso ao aluno: o próprio (maior, com conta) ou o encarregado que gere o menor.
   */
  async sendFamily(noticeId: string, kind: string, link: string, today: string, now: Date) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      WITH notice AS (UPDATE exam_notices SET family_sent_at = ${now}::timestamp, error = NULL WHERE id = ${noticeId}::uuid AND family_sent_at IS NULL RETURNING group_ids, title, body),
      type AS (SELECT coalesce((SELECT enabled FROM notification_types WHERE kind = ${kind}), true) AS on_),
      rec AS (
        SELECT st.id AS student_id, st.account_id FROM students st WHERE st.account_id IS NOT NULL
        UNION
        SELECT sg.student_id, gu.account_id FROM student_guardians sg JOIN guardians gu ON gu.id = sg.guardian_id JOIN students st ON st.id = sg.student_id
         WHERE sg.can_manage AND gu.account_id IS NOT NULL AND ${today}::date < (st.birth_date + interval '18 years')::date
      ),
      target AS (
        SELECT DISTINCT fa.id AS account_id, fa.full_name, st.id AS student_id, left(n.title || ' · ' || split_part(st.full_name, ' ', 1), 200) AS title, n.body
          FROM notice n JOIN enrollments en ON en.group_id = ANY(n.group_ids) AND en.status = 'ACTIVE' JOIN students st ON st.id = en.student_id
          JOIN rec ON rec.student_id = st.id JOIN family_accounts fa ON fa.id = rec.account_id AND fa.status = 'ACTIVE'
      ),
      ins AS (
        INSERT INTO family_notifications (id, account_id, kind, title, body, link, student_id, created_at)
        SELECT gen_random_uuid(), t.account_id, ${kind}, t.title, t.body, ${link} || t.student_id, t.student_id, ${now}::timestamp FROM target t, type WHERE type.on_
        RETURNING id, account_id, student_id
      ),
      log AS (
        INSERT INTO notification_deliveries (id, audience, notification_id, recipient_id, recipient_name, kind, title, channel, status, error, created_at)
        SELECT gen_random_uuid(), 'FAMILY', i.id, t.account_id, t.full_name, ${kind}, t.title, 'IN_APP', CASE WHEN type.on_ THEN 'SENT' ELSE 'SKIPPED' END, CASE WHEN type.on_ THEN NULL ELSE 'Tipo desligado pelo colégio' END, ${now}::timestamp
          FROM target t CROSS JOIN type LEFT JOIN ins i ON i.account_id = t.account_id AND i.student_id = t.student_id
      )
      SELECT count(*)::int AS n FROM ins`;
    return r?.n ?? 0;
  }

  // ------------------------------------------------------------------ professor e família (só publicado)

  async employeeOfUser(userId: string) {
    const r = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM employees WHERE user_id = ${userId}::uuid`;
    return r[0]?.id ?? null;
  }

  private async published(where: Prisma.Sql): Promise<PublicExam[]> {
    const r = await this.db.$queryRaw<(Omit<PublicExam, "groupLabel"> & { groupName: string; grade: number; courseCode: string | null })[]>`
      SELECT ${EXAM}, s.name AS "seasonName", s.interrupts, g.name AS "groupName", g.room AS "groupRoom", c.grade, co.code AS "courseCode"
        FROM exams e JOIN exam_seasons s ON s.id = e.season_id AND s.status = 'PUBLISHED' JOIN subjects su ON su.id = e.subject_id LEFT JOIN employees t ON t.id = e.teacher_id
        JOIN class_groups g ON g.id = e.group_id JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
       WHERE ${where} ORDER BY e.day, e.starts_at, su.name`;
    return r.map(({ groupName, grade, courseCode, ...x }) => ({ ...x, groupLabel: groupLabel({ name: groupName, grade, courseCode }) }));
  }

  /** As provas que dizem respeito ao professor: as que tem a cargo, as das suas disciplinas e as das turmas que coordena. */
  teacherExams(employeeId: string) {
    return this.published(Prisma.sql`(e.teacher_id = ${employeeId}::uuid OR g.coordinator_id = ${employeeId}::uuid
      OR EXISTS (SELECT 1 FROM group_teachers gt WHERE gt.group_id = e.group_id AND gt.subject_id = e.subject_id AND gt.employee_id = ${employeeId}::uuid))
      AND e.day >= (SELECT coalesce(min(starts_on), '1900-01-01') FROM academic_years WHERE status <> 'CLOSED')`);
  }

  async coordinatedGroupIds(employeeId: string) {
    const r = await this.db.$queryRaw<{ id: string }[]>`SELECT id FROM class_groups WHERE coordinator_id = ${employeeId}::uuid`;
    return new Set(r.map((x) => x.id));
  }

  groupExams(groupId: string) {
    return this.published(Prisma.sql`e.group_id = ${groupId}::uuid`);
  }

  /** As épocas publicadas de uma turma (para dizer se há aulas). */
  async groupSeasons(groupIds: string[]) {
    return this.db.$queryRaw<{ id: string; name: string; startsOn: string; endsOn: string; interrupts: boolean; notes: string | null; groupIds: string[] }[]>`
      SELECT s.id, s.name, to_char(s.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(s.ends_on, 'YYYY-MM-DD') AS "endsOn", s.interrupts, s.notes, array_agg(sg.group_id::text) AS "groupIds"
        FROM exam_seasons s JOIN exam_season_groups sg ON sg.season_id = s.id WHERE s.status = 'PUBLISHED' AND sg.group_id = ANY(${groupIds}::uuid[])
       GROUP BY s.id, s.name, s.starts_on, s.ends_on, s.interrupts, s.notes ORDER BY s.starts_on`;
  }

  // ------------------------------------------------------------------ época publicada depois de começar

  /** Dispensa as aulas por decidir no RH que passam a estar suspensas. */
  async dismissPendings(groupIds: string[], from: string, to: string, reason: string, actorId: string | null, now: Date) {
    return this.db.$executeRaw`
      UPDATE lesson_pendings SET status = 'DISMISSED', reason = ${reason}, decided_by_id = ${actorId}::uuid, decided_at = ${now}
       WHERE group_id = ANY(${groupIds}::uuid[]) AND day BETWEEN ${from}::date AND ${to}::date AND status = 'OPEN'`;
  }

  /** Aulas suspensas que já têm presenças registadas (a publicação não as apaga): para avisar. */
  async sessionsInside(groupIds: string[], from: string, to: string) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM lesson_sessions WHERE group_id = ANY(${groupIds}::uuid[]) AND day BETWEEN ${from}::date AND ${to}::date`;
    return r?.n ?? 0;
  }
}
