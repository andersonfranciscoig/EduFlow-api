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
         a.revision, (SELECT count(*)::int FROM grading_marks m WHERE m.assessment_id = a.id) AS marks, a.created_at AS "createdAt", u.full_name AS "createdByName"
    FROM grading_assessments a LEFT JOIN grading_types t ON t.id = a.type_id LEFT JOIN school_users u ON u.id = a.created_by_id`;

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
      SELECT g.id AS "groupId", g.name AS "groupName", g.shift, c.grade, co.name AS "courseName",
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
  async createAssessment(book: { yearId: string; groupId: string; subjectId: string }, input: AssessmentInput, actor: Actor, now: Date) {
    const id = randomUUID();
    await this.db.$executeRaw`
      INSERT INTO grading_assessments (id, academic_year_id, group_id, subject_id, period_position, component_key, type_id, name, held_on, out_of, weight, created_by_id, created_at, updated_by_id, updated_at)
      VALUES (${id}::uuid, ${book.yearId}::uuid, ${book.groupId}::uuid, ${book.subjectId}::uuid, ${input.period}, ${input.componentKey}, ${input.typeId}::uuid, ${input.name}, ${input.heldOn}::date,
              ${input.outOf}::numeric, ${input.weight}::numeric, ${actor.id}::uuid, ${now}, ${actor.id}::uuid, ${now})`;
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
