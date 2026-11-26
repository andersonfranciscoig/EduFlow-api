import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { MarkState } from "../domain/engine";

type Db = PrismaClient | Prisma.TransactionClient;
const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export interface BookRow {
  groupId: string;
  groupName: string;
  shift: string;
  yearId: string;
  yearName: string;
  yearStatus: string;
  periodKind: string;
  classId: string;
  grade: number;
  courseId: string | null;
  courseName: string | null;
  coordinatorId: string | null;
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  subjectColor: string;
  /** a disciplina está no plano curricular da classe */
  inCurriculum: boolean;
  teacherId: string | null;
  teacherName: string | null;
}
export interface PeriodRow {
  position: number;
  startsOn: string;
  endsOn: string;
}
export interface StudentRow {
  id: string;
  name: string;
  number: number | null;
}
export interface AssessmentRow {
  id: string;
  yearId: string;
  groupId: string;
  subjectId: string;
  period: number;
  componentKey: string;
  typeId: string | null;
  typeName: string | null;
  name: string;
  heldOn: string | null;
  outOf: number | null;
  weight: number | null;
  revision: number;
  marks: number;
  createdAt: Date;
  createdByName: string | null;
  /** a prova do calendário que regista (null = avaliação do professor) */
  examId: string | null;
  examDay: string | null;
  examStatus: string | null;
  seasonName: string | null;
}
/** Uma prova do calendário publicado, para uma turma e disciplina. */
export interface CalendarExamRow {
  id: string;
  seasonName: string;
  seasonPosition: number;
  day: string;
  startsAt: string;
  endsAt: string;
  room: string | null;
  format: string;
  status: string;
  cancelReason: string | null;
  assessmentId: string | null;
}
export interface MarkRow {
  assessmentId: string;
  studentId: string;
  state: MarkState;
  score: number | null;
  note: string | null;
}
export interface NoteRow {
  studentId: string;
  level: string | null;
  comment: string | null;
}
export interface ChangeRow {
  at: Date;
  kind: string;
  byName: string | null;
  assessmentId: string | null;
  studentId: string | null;
  studentName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}
export interface MyBookRow {
  classId: string;
  groupId: string;
  groupName: string;
  shift: string;
  grade: number;
  courseName: string | null;
  subjectId: string;
  subjectName: string;
  subjectCode: string;
  subjectColor: string;
  students: number;
  assessments: number;
  teacherName: string | null;
  mine: boolean;
}
export interface Actor {
  id: string | null;
  name: string | null;
}
export type TermStatus = "RETURNED" | "SUBMITTED" | "VALIDATED" | "PUBLISHED" | "REOPENED";
/** O estado das classificações de uma disciplina numa turma e período (sem linha = em preparação). */
export interface TermRow {
  yearId: string;
  groupId: string;
  subjectId: string;
  period: number;
  status: TermStatus;
  revision: number;
  modelId: string | null;
  modelVersion: number | null;
  results: FrozenResults | null;
  publications: number;
  note: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  validatedAt: Date | null;
  validatedBy: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
}
/** As classificações congeladas na submissão (o que se valida e publica). */
export interface FrozenResults {
  students: { id: string; name: string; number: number | null; status: string; value: number | null; level: string | null; passed: boolean | null; comment: string | null }[];
  stats: { students: number; done: number; passed: number; average: number | null };
}
export interface TermKey {
  yearId: string;
  groupId: string;
  subjectId: string;
  period: number;
}
export interface AssessmentInput {
  period: number;
  componentKey: string;
  typeId: string | null;
  name: string;
  heldOn: string | null;
  outOf: number | null;
  weight: number | null;
}
type Snapshot = { state: MarkState; score: number | null; note: string | null } | null;

const BOOK = Prisma.sql`
  SELECT g.id AS "groupId", g.name AS "groupName", g.shift, y.id AS "yearId", y.name AS "yearName", y.status AS "yearStatus", y.period_kind AS "periodKind",
         c.id AS "classId", c.grade, c.course_id AS "courseId", co.name AS "courseName", g.coordinator_id AS "coordinatorId",
         s.id AS "subjectId", s.name AS "subjectName", s.code AS "subjectCode", s.color AS "subjectColor",
         EXISTS (SELECT 1 FROM class_subjects cs WHERE cs.class_id = c.id AND cs.subject_id = s.id) AS "inCurriculum",
         gt.employee_id AS "teacherId", e.full_name AS "teacherName"
    FROM class_groups g JOIN academic_years y ON y.id = g.academic_year_id JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
    CROSS JOIN subjects s
    LEFT JOIN group_teachers gt ON gt.group_id = g.id AND gt.subject_id = s.id LEFT JOIN employees e ON e.id = gt.employee_id`;
const ASSESSMENT = Prisma.sql`
  SELECT a.id, a.academic_year_id AS "yearId", a.group_id AS "groupId", a.subject_id AS "subjectId", a.period_position AS period, a.component_key AS "componentKey",
         a.type_id AS "typeId", t.name AS "typeName", a.name, to_char(a.held_on, 'YYYY-MM-DD') AS "heldOn", a.out_of::float8 AS "outOf", a.weight::float8 AS weight,
         a.revision, (SELECT count(*)::int FROM grading_marks m WHERE m.assessment_id = a.id) AS marks, a.created_at AS "createdAt", u.full_name AS "createdByName",
         a.exam_id AS "examId", to_char(e.day, 'YYYY-MM-DD') AS "examDay", e.status AS "examStatus", es.name AS "seasonName"
    FROM grading_assessments a LEFT JOIN grading_types t ON t.id = a.type_id LEFT JOIN school_users u ON u.id = a.created_by_id
    LEFT JOIN exams e ON e.id = a.exam_id LEFT JOIN exam_seasons es ON es.id = e.season_id`;

/** A caderneta digital, na BD do colégio: avaliações, notas, menções e o histórico (só de acrescentar). */
export class PrismaGradebookRepository {
  constructor(
    private readonly db: Db,
    private readonly root: PrismaClient | null = null,
  ) {}
  static for(db: PrismaClient) {
    return new PrismaGradebookRepository(db, db);
  }
  /** Escritas numa caderneta: uma de cada vez (o que se verifica, por exemplo o máximo de avaliações, é o que se grava). */
  async locked<T>(groupId: string, subjectId: string, work: (repo: PrismaGradebookRepository) => Promise<T>): Promise<T> {
    if (!this.root) throw new Error("já está numa transação");
    return this.root.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gradebook:${groupId}:${subjectId}`}))`;
      return work(new PrismaGradebookRepository(tx));
    });
  }

  // ================================================================ quem é quem

  async employeeOfUser(userId: string) {
    const r = await this.db.$queryRaw<{ id: string; fullName: string }[]>`SELECT id, full_name AS "fullName" FROM employees WHERE user_id = ${userId}::uuid`;
    return r[0] ?? null;
  }
  async userName(userId: string) {
    const r = await this.db.$queryRaw<{ name: string }[]>`SELECT full_name AS name FROM school_users WHERE id = ${userId}::uuid`;
    return r[0]?.name ?? null;
  }
  async currentYear(today: string) {
    const r = await this.db.$queryRaw<{ id: string; name: string; status: string; periodKind: string }[]>`
      SELECT id, name, status, period_kind AS "periodKind" FROM academic_years
       WHERE status = 'ACTIVE' OR (status <> 'CLOSED' AND ends_on >= ${today}::date)
       ORDER BY (status = 'ACTIVE') DESC, starts_on LIMIT 1`;
    return r[0] ?? null;
  }
  years() {
    return this.db.$queryRaw<{ id: string; name: string; status: string; periodKind: string }[]>`
      SELECT id, name, status, period_kind AS "periodKind" FROM academic_years ORDER BY starts_on DESC`;
  }

  // ================================================================ cadernetas

  async book(groupId: string, subjectId: string): Promise<BookRow | null> {
    return (await this.db.$queryRaw<BookRow[]>`${BOOK} WHERE g.id = ${groupId}::uuid AND s.id = ${subjectId}::uuid`)[0] ?? null;
  }
  /** As cadernetas do professor (as suas disciplinas) e as das turmas que coordena. */
  myBooks(employeeId: string, yearId: string) {
    return this.db.$queryRaw<MyBookRow[]>`
      SELECT c.id AS "classId", g.id AS "groupId", g.name AS "groupName", g.shift, c.grade, co.name AS "courseName",
             s.id AS "subjectId", s.name AS "subjectName", s.code AS "subjectCode", s.color AS "subjectColor",
             (SELECT count(*)::int FROM enrollments en WHERE en.group_id = g.id AND en.status = 'ACTIVE') AS students,
             (SELECT count(*)::int FROM grading_assessments a WHERE a.group_id = g.id AND a.subject_id = s.id) AS assessments,
             e.full_name AS "teacherName", (gt.employee_id IS NOT DISTINCT FROM ${employeeId}::uuid) AS mine
        FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
        JOIN class_subjects cs ON cs.class_id = c.id JOIN subjects s ON s.id = cs.subject_id
        LEFT JOIN group_teachers gt ON gt.group_id = g.id AND gt.subject_id = s.id LEFT JOIN employees e ON e.id = gt.employee_id
       WHERE g.academic_year_id = ${yearId}::uuid AND (gt.employee_id = ${employeeId}::uuid OR g.coordinator_id = ${employeeId}::uuid)
       ORDER BY c.grade, co.name NULLS FIRST, g.name, cs.position, s.name`;
  }
  /** Todas as cadernetas de um ano (a gestão): classe → turma → disciplina, com o andamento. */
  allBooks(yearId: string) {
    return this.db.$queryRaw<
      { classId: string; grade: number; courseId: string | null; courseName: string | null; groupId: string; groupName: string; shift: string; students: number; subjectId: string; subjectName: string; subjectCode: string; subjectColor: string; teacherName: string | null; assessments: number; marks: number }[]
    >`
      SELECT c.id AS "classId", c.grade, c.course_id AS "courseId", co.name AS "courseName", g.id AS "groupId", g.name AS "groupName", g.shift,
             (SELECT count(*)::int FROM enrollments en WHERE en.group_id = g.id AND en.status = 'ACTIVE') AS students,
             s.id AS "subjectId", s.name AS "subjectName", s.code AS "subjectCode", s.color AS "subjectColor", e.full_name AS "teacherName",
             (SELECT count(*)::int FROM grading_assessments a WHERE a.group_id = g.id AND a.subject_id = s.id) AS assessments,
             (SELECT count(*)::int FROM grading_marks m JOIN grading_assessments a ON a.id = m.assessment_id WHERE a.group_id = g.id AND a.subject_id = s.id) AS marks
        FROM class_groups g JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id
        JOIN class_subjects cs ON cs.class_id = c.id JOIN subjects s ON s.id = cs.subject_id
        LEFT JOIN group_teachers gt ON gt.group_id = g.id AND gt.subject_id = s.id LEFT JOIN employees e ON e.id = gt.employee_id
       WHERE g.academic_year_id = ${yearId}::uuid
       ORDER BY c.grade, co.name NULLS FIRST, g.name, cs.position, s.name`;
  }
  periods(yearId: string) {
    return this.db.$queryRaw<PeriodRow[]>`
      SELECT position, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM academic_periods WHERE academic_year_id = ${yearId}::uuid ORDER BY position`;
  }
  /** Os alunos da turma (matrícula ativa), por ordem alfabética. */
  students(groupId: string) {
    return this.db.$queryRaw<StudentRow[]>`
      SELECT st.id, st.full_name AS name, st.number FROM enrollments en JOIN students st ON st.id = en.student_id
       WHERE en.group_id = ${groupId}::uuid AND en.status = 'ACTIVE' ORDER BY lower(st.full_name), st.id`;
  }
  assessments(groupId: string, subjectId: string, period: number | null) {
    const p = period === null ? Prisma.empty : Prisma.sql`AND a.period_position = ${period}`;
    return this.db.$queryRaw<AssessmentRow[]>`${ASSESSMENT} WHERE a.group_id = ${groupId}::uuid AND a.subject_id = ${subjectId}::uuid ${p} ORDER BY a.period_position, a.held_on NULLS LAST, a.created_at`;
  }
  async assessment(id: string): Promise<AssessmentRow | null> {
    return (await this.db.$queryRaw<AssessmentRow[]>`${ASSESSMENT} WHERE a.id = ${id}::uuid`)[0] ?? null;
  }
  marks(assessmentIds: string[]) {
    if (!assessmentIds.length) return Promise.resolve([] as MarkRow[]);
    return this.db.$queryRaw<MarkRow[]>`
      SELECT assessment_id AS "assessmentId", student_id AS "studentId", state, score::float8 AS score, note FROM grading_marks WHERE assessment_id = ANY(${assessmentIds}::uuid[])`;
  }
  /** As provas do calendário publicado desta turma e disciplina num período (e a avaliação que as regista). */
  calendarExams(yearId: string, groupId: string, subjectId: string, period: number) {
    return this.db.$queryRaw<CalendarExamRow[]>`
      SELECT e.id, s.name AS "seasonName", s.position AS "seasonPosition", to_char(e.day, 'YYYY-MM-DD') AS day, to_char(e.starts_at, 'HH24:MI') AS "startsAt", to_char(e.ends_at, 'HH24:MI') AS "endsAt",
             e.room, e.format, e.status, e.cancel_reason AS "cancelReason", (SELECT a.id FROM grading_assessments a WHERE a.exam_id = e.id) AS "assessmentId"
        FROM exams e JOIN exam_seasons s ON s.id = e.season_id
       WHERE s.academic_year_id = ${yearId}::uuid AND s.period_position = ${period} AND s.status = 'PUBLISHED'
         AND e.group_id = ${groupId}::uuid AND e.subject_id = ${subjectId}::uuid
       ORDER BY e.day, e.starts_at, s.position`;
  }
  async calendarExam(id: string) {
    const r = await this.db.$queryRaw<(CalendarExamRow & { yearId: string; period: number; groupId: string; subjectId: string; seasonStatus: string })[]>`
      SELECT e.id, s.name AS "seasonName", s.position AS "seasonPosition", to_char(e.day, 'YYYY-MM-DD') AS day, to_char(e.starts_at, 'HH24:MI') AS "startsAt", to_char(e.ends_at, 'HH24:MI') AS "endsAt",
             e.room, e.format, e.status, e.cancel_reason AS "cancelReason", (SELECT a.id FROM grading_assessments a WHERE a.exam_id = e.id) AS "assessmentId",
             s.academic_year_id AS "yearId", s.period_position AS period, e.group_id AS "groupId", e.subject_id AS "subjectId", s.status AS "seasonStatus"
        FROM exams e JOIN exam_seasons s ON s.id = e.season_id WHERE e.id = ${id}::uuid`;
    return r[0] ?? null;
  }
  notes(groupId: string, subjectId: string, period: number) {
    return this.db.$queryRaw<NoteRow[]>`
      SELECT student_id AS "studentId", level_key AS level, comment FROM grading_period_notes WHERE group_id = ${groupId}::uuid AND subject_id = ${subjectId}::uuid AND period_position = ${period}`;
  }
  history(groupId: string, subjectId: string, period: number, limit = 80) {
    return this.db.$queryRaw<ChangeRow[]>`
      SELECT h.at, h.kind, h.by_name AS "byName", h.assessment_id AS "assessmentId", h.student_id AS "studentId", st.full_name AS "studentName", h.before, h.after, h.reason
        FROM grading_changes h LEFT JOIN students st ON st.id = h.student_id
       WHERE h.group_id = ${groupId}::uuid AND h.subject_id = ${subjectId}::uuid AND h.period_position = ${period} ORDER BY h.at DESC, h.id LIMIT ${limit}`;
  }

  // ================================================================ fecho dos períodos

  async term(groupId: string, subjectId: string, period: number): Promise<TermRow | null> {
    const r = await this.db.$queryRaw<TermRow[]>`
      SELECT t.academic_year_id AS "yearId", t.group_id AS "groupId", t.subject_id AS "subjectId", t.period_position AS period, t.status, t.revision, t.model_id AS "modelId", t.model_version AS "modelVersion",
             t.results, t.publications, t.note, t.submitted_at AS "submittedAt", us.full_name AS "submittedBy", t.validated_at AS "validatedAt", uv.full_name AS "validatedBy", t.published_at AS "publishedAt", up.full_name AS "publishedBy"
        FROM grading_terms t LEFT JOIN school_users us ON us.id = t.submitted_by_id LEFT JOIN school_users uv ON uv.id = t.validated_by_id LEFT JOIN school_users up ON up.id = t.published_by_id
       WHERE t.group_id = ${groupId}::uuid AND t.subject_id = ${subjectId}::uuid AND t.period_position = ${period}`;
    return r[0] ?? null;
  }
  /** O estado de todas as disciplinas de um ano e período (para a validação e a publicação). */
  terms(yearId: string, period: number) {
    return this.db.$queryRaw<{ groupId: string; subjectId: string; status: TermStatus; revision: number; publications: number; note: string | null; submittedAt: Date | null }[]>`
      SELECT group_id AS "groupId", subject_id AS "subjectId", status, revision, publications, note, submitted_at AS "submittedAt" FROM grading_terms WHERE academic_year_id = ${yearId}::uuid AND period_position = ${period}`;
  }
  /** Submete (ou volta a submeter): congela as classificações. false = mudou entretanto. */
  async submitTerm(k: TermKey, expected: TermRow | null, data: { modelId: string; modelVersion: number; results: FrozenResults }, actor: Actor, now: Date) {
    const results = JSON.stringify(data.results);
    const n = expected
      ? await this.db.$executeRaw`
          UPDATE grading_terms SET status = 'SUBMITTED', revision = revision + 1, model_id = ${data.modelId}::uuid, model_version = ${data.modelVersion}, results = ${results}::jsonb,
                 submitted_at = ${now}, submitted_by_id = ${actor.id}::uuid, validated_at = NULL, validated_by_id = NULL, updated_at = ${now}
           WHERE group_id = ${k.groupId}::uuid AND subject_id = ${k.subjectId}::uuid AND period_position = ${k.period} AND status IN ('RETURNED', 'REOPENED') AND revision = ${expected.revision}`
      : await this.db.$executeRaw`
          INSERT INTO grading_terms (academic_year_id, group_id, subject_id, period_position, status, model_id, model_version, results, submitted_at, submitted_by_id, updated_at)
          VALUES (${k.yearId}::uuid, ${k.groupId}::uuid, ${k.subjectId}::uuid, ${k.period}, 'SUBMITTED', ${data.modelId}::uuid, ${data.modelVersion}, ${results}::jsonb, ${now}, ${actor.id}::uuid, ${now})
          ON CONFLICT DO NOTHING`;
    if (n !== 1) return false;
    await this.change(k, "TERM_SUBMITTED", { after: { status: "SUBMITTED", modelVersion: data.modelVersion, stats: data.results.stats } }, actor, now);
    return true;
  }
  /** Muda de estado (validar, devolver, reabrir). false = já não estava no estado esperado. */
  async moveTerm(k: TermKey, from: TermStatus[], to: TermStatus, revision: number, kind: "TERM_VALIDATED" | "TERM_RETURNED" | "TERM_REOPENED", reason: string | null, actor: Actor, now: Date) {
    const validated = to === "VALIDATED";
    const n = await this.db.$executeRaw`
      UPDATE grading_terms SET status = ${to}, revision = revision + 1, note = CASE WHEN ${reason}::text IS NULL THEN note ELSE ${reason} END,
             validated_at = CASE WHEN ${validated} THEN ${now} ELSE NULL END, validated_by_id = CASE WHEN ${validated} THEN ${actor.id}::uuid ELSE NULL END, updated_at = ${now}
       WHERE group_id = ${k.groupId}::uuid AND subject_id = ${k.subjectId}::uuid AND period_position = ${k.period} AND status = ANY(${from}) AND revision = ${revision}`;
    if (n !== 1) return false;
    await this.change(k, kind, { before: { status: from }, after: { status: to }, reason }, actor, now);
    return true;
  }
  /** Publica: o que foi validado fica numa publicação imutável. Devolve o número da publicação, ou null. */
  async publishTerm(k: TermKey, revision: number, actor: Actor, now: Date): Promise<number | null> {
    const r = await this.db.$queryRaw<{ publications: number; results: FrozenResults; modelId: string | null; modelVersion: number | null; note: string | null }[]>`
      UPDATE grading_terms SET status = 'PUBLISHED', revision = revision + 1, publications = publications + 1, published_at = ${now}, published_by_id = ${actor.id}::uuid, updated_at = ${now}
       WHERE group_id = ${k.groupId}::uuid AND subject_id = ${k.subjectId}::uuid AND period_position = ${k.period} AND status = 'VALIDATED' AND revision = ${revision}
       RETURNING publications, results, model_id AS "modelId", model_version AS "modelVersion", note`;
    if (!r[0]) return null;
    const p = r[0];
    // da 2.ª em diante é uma retificação: o motivo é o da reabertura
    const reason = p.publications > 1 ? p.note : null;
    await this.db.$executeRaw`
      INSERT INTO grading_publications (id, academic_year_id, group_id, subject_id, period_position, number, model_id, model_version, results, reason, published_by_id, published_by_name, published_at)
      VALUES (${randomUUID()}::uuid, ${k.yearId}::uuid, ${k.groupId}::uuid, ${k.subjectId}::uuid, ${k.period}, ${p.publications}, ${p.modelId}::uuid, ${p.modelVersion}, ${JSON.stringify(p.results)}::jsonb, ${reason}, ${actor.id}::uuid, ${actor.name}, ${now})`;
    await this.change(k, "TERM_PUBLISHED", { after: { status: "PUBLISHED", publication: p.publications }, reason }, actor, now);
    return p.publications;
  }
  async groupInfo(groupId: string) {
    const r = await this.db.$queryRaw<{ yearId: string; yearStatus: string }[]>`
      SELECT y.id AS "yearId", y.status AS "yearStatus" FROM class_groups g JOIN academic_years y ON y.id = g.academic_year_id WHERE g.id = ${groupId}::uuid`;
    return r[0] ?? null;
  }
  /** As disciplinas do plano curricular da classe da turma. */
  groupSubjects(groupId: string) {
    return this.db.$queryRaw<{ id: string; name: string; code: string; color: string }[]>`
      SELECT s.id, s.name, s.code, s.color FROM class_groups g JOIN class_subjects cs ON cs.class_id = g.class_id JOIN subjects s ON s.id = cs.subject_id WHERE g.id = ${groupId}::uuid ORDER BY cs.position, s.name`;
  }
  async groupHeader(groupId: string) {
    const r = await this.db.$queryRaw<{ yearId: string; yearName: string; periodKind: string; groupName: string; grade: number; courseName: string | null }[]>`
      SELECT y.id AS "yearId", y.name AS "yearName", y.period_kind AS "periodKind", g.name AS "groupName", c.grade, co.name AS "courseName"
        FROM class_groups g JOIN academic_years y ON y.id = g.academic_year_id JOIN school_classes c ON c.id = g.class_id LEFT JOIN courses co ON co.id = c.course_id WHERE g.id = ${groupId}::uuid`;
    return r[0] ?? null;
  }
  // ================================================================ a quem avisar

  /** A conta do portal do diretor de turma (se tiver). */
  async coordinatorUser(groupId: string) {
    const r = await this.db.$queryRaw<{ id: string }[]>`
      SELECT e.user_id AS id FROM class_groups g JOIN employees e ON e.id = g.coordinator_id WHERE g.id = ${groupId}::uuid AND e.user_id IS NOT NULL`;
    return r[0]?.id ?? null;
  }
  async userOfEmployee(employeeId: string) {
    const r = await this.db.$queryRaw<{ id: string }[]>`SELECT user_id AS id FROM employees WHERE id = ${employeeId}::uuid AND user_id IS NOT NULL`;
    return r[0]?.id ?? null;
  }
  /** Quem tem uma permissão da avaliação (e o responsável do colégio). */
  usersWith(permission: string) {
    return this.db.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM school_users u WHERE u.status = 'ACTIVE' AND (u.is_owner OR EXISTS (SELECT 1 FROM school_user_permissions p WHERE p.user_id = u.id AND p.permission = ${permission}))`;
  }
  /**
   * Avisa as famílias dos alunos de uma turma de que há classificações publicadas: o próprio aluno
   * (com conta) e, enquanto for menor, os encarregados que o gerem. Uma notificação por aluno e conta.
   */
  async notifyFamilies(groupId: string, kind: string, titlePrefix: string, body: string, link: string, today: string, now: Date) {
    const [r] = await this.db.$queryRaw<{ n: number }[]>`
      WITH type AS (SELECT coalesce((SELECT enabled FROM notification_types WHERE kind = ${kind}), true) AS on_),
      rec AS (
        SELECT st.id AS student_id, st.account_id FROM students st WHERE st.account_id IS NOT NULL
        UNION
        SELECT sg.student_id, gu.account_id FROM student_guardians sg JOIN guardians gu ON gu.id = sg.guardian_id JOIN students st ON st.id = sg.student_id
         WHERE sg.can_manage AND gu.account_id IS NOT NULL AND ${today}::date < (st.birth_date + interval '18 years')::date
      ),
      target AS (
        SELECT DISTINCT fa.id AS account_id, fa.full_name, st.id AS student_id, left(${titlePrefix} || ' · ' || split_part(st.full_name, ' ', 1), 200) AS title
          FROM enrollments en JOIN students st ON st.id = en.student_id JOIN rec ON rec.student_id = st.id JOIN family_accounts fa ON fa.id = rec.account_id AND fa.status = 'ACTIVE'
         WHERE en.group_id = ${groupId}::uuid AND en.status = 'ACTIVE'
      ),
      ins AS (
        INSERT INTO family_notifications (id, account_id, kind, title, body, link, student_id, created_at)
        SELECT gen_random_uuid(), t.account_id, ${kind}, t.title, ${body}, ${link} || t.student_id, t.student_id, ${now}::timestamp FROM target t, type WHERE type.on_
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
  /** As classificações publicadas de um aluno num ano (a última publicação de cada disciplina e período). */
  studentPublications(yearId: string, studentId: string) {
    return this.db.$queryRaw<{ subjectId: string; period: number; number: number; publishedAt: Date; reason: string | null; result: { status: string; value: number | null; level: string | null; passed: boolean | null; comment: string | null } }[]>`
      SELECT DISTINCT ON (p.subject_id, p.period_position) p.subject_id AS "subjectId", p.period_position AS period, p.number, p.published_at AS "publishedAt", p.reason, st AS result
        FROM grading_publications p CROSS JOIN LATERAL jsonb_array_elements(p.results->'students') st
       WHERE p.academic_year_id = ${yearId}::uuid AND st->>'id' = ${studentId}
       ORDER BY p.subject_id, p.period_position, p.number DESC`;
  }
  publications(groupId: string, subjectId: string, period: number) {
    return this.db.$queryRaw<{ number: number; reason: string | null; publishedAt: Date; publishedBy: string | null; modelVersion: number | null }[]>`
      SELECT number, reason, published_at AS "publishedAt", published_by_name AS "publishedBy", model_version AS "modelVersion" FROM grading_publications
       WHERE group_id = ${groupId}::uuid AND subject_id = ${subjectId}::uuid AND period_position = ${period} ORDER BY number DESC`;
  }

  // ================================================================ escrever (dentro de `locked`)

  private async change(book: { yearId: string; groupId: string; subjectId: string; period: number }, kind: string, x: { assessmentId?: string | null; studentId?: string | null; before?: unknown; after?: unknown; reason?: string | null }, actor: Actor, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO grading_changes (id, academic_year_id, group_id, subject_id, period_position, assessment_id, student_id, kind, before, after, reason, by_id, by_name, at)
      VALUES (${randomUUID()}::uuid, ${book.yearId}::uuid, ${book.groupId}::uuid, ${book.subjectId}::uuid, ${book.period}, ${x.assessmentId ?? null}::uuid, ${x.studentId ?? null}::uuid, ${kind},
              ${json(x.before)}::jsonb, ${json(x.after)}::jsonb, ${x.reason ?? null}, ${actor.id}::uuid, ${actor.name}, ${now})`;
  }
  async countIn(groupId: string, subjectId: string, period: number, componentKey: string, except: string | null = null) {
    const r = await this.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM grading_assessments WHERE group_id = ${groupId}::uuid AND subject_id = ${subjectId}::uuid AND period_position = ${period} AND component_key = ${componentKey}
         AND id IS DISTINCT FROM ${except}::uuid`;
    return r[0].n;
  }
  async createAssessment(book: { yearId: string; groupId: string; subjectId: string }, input: AssessmentInput & { examId?: string | null }, actor: Actor, now: Date) {
    const id = randomUUID();
    await this.db.$executeRaw`
      INSERT INTO grading_assessments (id, academic_year_id, group_id, subject_id, period_position, component_key, type_id, name, held_on, out_of, weight, exam_id, created_by_id, created_at, updated_by_id, updated_at)
      VALUES (${id}::uuid, ${book.yearId}::uuid, ${book.groupId}::uuid, ${book.subjectId}::uuid, ${input.period}, ${input.componentKey}, ${input.typeId}::uuid, ${input.name}, ${input.heldOn}::date,
              ${input.outOf}::numeric, ${input.weight}::numeric, ${input.examId ?? null}::uuid, ${actor.id}::uuid, ${now}, ${actor.id}::uuid, ${now})`;
    await this.change({ ...book, period: input.period }, "ASSESSMENT_CREATED", { assessmentId: id, after: input }, actor, now);
    return id;
  }
  /** Devolve false se a avaliação mudou entretanto (revisão). */
  async updateAssessment(a: AssessmentRow, revision: number, input: Omit<AssessmentInput, "period" | "componentKey">, actor: Actor, now: Date) {
    const n = await this.db.$executeRaw`
      UPDATE grading_assessments SET type_id = ${input.typeId}::uuid, name = ${input.name}, held_on = ${input.heldOn}::date, out_of = ${input.outOf}::numeric, weight = ${input.weight}::numeric,
             revision = revision + 1, updated_by_id = ${actor.id}::uuid, updated_at = ${now}
       WHERE id = ${a.id}::uuid AND revision = ${revision}`;
    if (n !== 1) return false;
    const before = { typeId: a.typeId, name: a.name, heldOn: a.heldOn, outOf: a.outOf, weight: a.weight };
    await this.change({ yearId: a.yearId, groupId: a.groupId, subjectId: a.subjectId, period: a.period }, "ASSESSMENT_UPDATED", { assessmentId: a.id, before, after: input }, actor, now);
    return true;
  }
  async deleteAssessment(a: AssessmentRow, actor: Actor, now: Date) {
    const marks = await this.marks([a.id]);
    await this.db.$executeRaw`DELETE FROM grading_assessments WHERE id = ${a.id}::uuid`;
    await this.change(
      { yearId: a.yearId, groupId: a.groupId, subjectId: a.subjectId, period: a.period },
      "ASSESSMENT_DELETED",
      { assessmentId: a.id, before: { name: a.name, componentKey: a.componentKey, outOf: a.outOf, marks: marks.map((m) => ({ studentId: m.studentId, state: m.state, score: m.score })) } },
      actor,
      now,
    );
  }
  /** Lança (ou retira: state null) notas de uma avaliação. Só regista no histórico o que mudou. */
  async setMarks(a: AssessmentRow, entries: { studentId: string; state: MarkState | null; score: number | null; note: string | null }[], reason: string | null, actor: Actor, now: Date) {
    const current = new Map((await this.marks([a.id])).map((m) => [m.studentId, m]));
    const book = { yearId: a.yearId, groupId: a.groupId, subjectId: a.subjectId, period: a.period };
    let changed = 0;
    for (const e of entries) {
      const old = current.get(e.studentId);
      const before: Snapshot = old ? { state: old.state, score: old.score, note: old.note } : null;
      const after: Snapshot = e.state ? { state: e.state, score: e.score, note: e.note } : null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (!after) await this.db.$executeRaw`DELETE FROM grading_marks WHERE assessment_id = ${a.id}::uuid AND student_id = ${e.studentId}::uuid`;
      else
        await this.db.$executeRaw`
          INSERT INTO grading_marks (assessment_id, student_id, state, score, note, updated_by_id, updated_at)
          VALUES (${a.id}::uuid, ${e.studentId}::uuid, ${after.state}, ${after.score}::numeric, ${after.note}, ${actor.id}::uuid, ${now})
          ON CONFLICT (assessment_id, student_id) DO UPDATE SET state = EXCLUDED.state, score = EXCLUDED.score, note = EXCLUDED.note, updated_by_id = EXCLUDED.updated_by_id, updated_at = EXCLUDED.updated_at`;
      await this.change(book, "MARK", { assessmentId: a.id, studentId: e.studentId, before, after, reason }, actor, now);
      changed++;
    }
    return changed;
  }
  async setNotes(book: { yearId: string; groupId: string; subjectId: string; period: number }, entries: { studentId: string; level: string | null; comment: string | null }[], actor: Actor, now: Date) {
    const current = new Map((await this.notes(book.groupId, book.subjectId, book.period)).map((n) => [n.studentId, n]));
    let changed = 0;
    for (const e of entries) {
      const old = current.get(e.studentId);
      const before = old && (old.level || old.comment) ? { level: old.level, comment: old.comment } : null;
      const after = e.level || e.comment ? { level: e.level, comment: e.comment } : null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (!after) await this.db.$executeRaw`DELETE FROM grading_period_notes WHERE group_id = ${book.groupId}::uuid AND subject_id = ${book.subjectId}::uuid AND period_position = ${book.period} AND student_id = ${e.studentId}::uuid`;
      else
        await this.db.$executeRaw`
          INSERT INTO grading_period_notes (academic_year_id, group_id, subject_id, period_position, student_id, level_key, comment, updated_by_id, updated_at)
          VALUES (${book.yearId}::uuid, ${book.groupId}::uuid, ${book.subjectId}::uuid, ${book.period}, ${e.studentId}::uuid, ${after.level}, ${after.comment}, ${actor.id}::uuid, ${now})
          ON CONFLICT (group_id, subject_id, period_position, student_id) DO UPDATE SET level_key = EXCLUDED.level_key, comment = EXCLUDED.comment, updated_by_id = EXCLUDED.updated_by_id, updated_at = EXCLUDED.updated_at`;
      await this.change(book, "NOTE", { studentId: e.studentId, before, after }, actor, now);
      changed++;
    }
    return changed;
  }
}
