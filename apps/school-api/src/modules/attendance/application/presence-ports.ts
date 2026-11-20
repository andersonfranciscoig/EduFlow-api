import type { Mark, PresenceStatus } from "../domain/presence";

export interface Counts {
  present: number;
  absent: number;
  late: number;
  justified: number;
  total: number;
}

export interface TeacherLessonRow {
  lessonId: string;
  startsAt: string;
  endsAt: string;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  subjectColor: string;
  room: string | null;
  session: { id: string; submittedAt: Date; late: boolean; counts: Counts } | null;
  /** substituição nesse dia: o nome do titular */
  substitutionFor: string | null;
}

export interface LessonRow {
  id: string;
  yearId: string;
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  teacherId: string | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
}

export interface RosterRow {
  id: string;
  fullName: string;
  number: string | null;
}

export interface SessionRow {
  id: string;
  lessonId: string | null;
  yearId: string;
  groupId: string;
  groupName: string;
  subjectName: string;
  teacherId: string | null;
  teacherName: string | null;
  day: string;
  startsAt: string;
  endsAt: string;
  submittedAt: Date;
  submittedByName: string | null;
  late: boolean;
  updatedAt: Date;
  counts: Counts;
  summary: string | null;
  summaryUpdatedAt: Date | null;
  /** n.º da lição (turma + disciplina + ano, pela ordem das aulas) */
  lessonNumber: number;
}

export interface SessionMarkRow extends Mark {
  fullName: string;
  number: string | null;
}

export interface GroupRow {
  id: string;
  name: string;
  classId: string;
  grade: number;
  courseName: string | null;
  shift: string;
  students: number;
  sessions: number;
}

export interface StudentSummaryRow {
  id: string;
  fullName: string;
  number: string | null;
  counts: Counts;
}

export interface PresenceRepository {
  employeeOfUser(userId: string): Promise<{ id: string; fullName: string } | null>;
  yearOn(day: string): Promise<{ id: string; name: string } | null>;
  /** o ano em curso (ACTIVE) ou, sem nenhum, o primeiro não encerrado que ainda não acabou */
  currentYear(today: string): Promise<{ id: string; name: string } | null>;
  closureOn(yearId: string, day: string): Promise<{ kindLabel: string; reason: string } | null>;
  teacherLessons(employeeId: string, yearId: string, day: string): Promise<TeacherLessonRow[]>;
  lesson(lessonId: string): Promise<LessonRow | null>;
  /** o substituto da aula nesse dia (null = sem substituição) */
  substituteOn(lessonId: string, day: string): Promise<string | null>;
  /** presenças submetidas depois do prazo: a aula pendente fica resolvida */
  resolvePending(groupId: string, day: string, startsAt: string, now: Date): Promise<void>;
  roster(groupId: string): Promise<RosterRow[]>;
  sessionAt(groupId: string, day: string, startsAt: string): Promise<SessionRow | null>;
  sessionById(id: string): Promise<SessionRow | null>;
  marks(sessionId: string): Promise<SessionMarkRow[]>;
  /** Cria ou atualiza a aula do dia e as presenças (todas, numa transação). Devolve o id. */
  saveSession(
    input: { id: string; lessonId: string | null; yearId: string; groupId: string; subjectId: string; teacherId: string | null; day: string; startsAt: string; endsAt: string; late: boolean },
    marks: Mark[],
    actorId: string | null,
    now: Date,
  ): Promise<string>;
  setSummary(sessionId: string, summary: string | null, actorId: string | null, now: Date): Promise<void>;
  coordinatedGroups(employeeId: string): Promise<GroupRow[]>;
  groupMarks(groupId: string): Promise<{ student_id: string; status: PresenceStatus; day: string; starts_at: string }[]>;
  groupSubjects(groupId: string): Promise<{ subject_name: string; color: string; teacher_name: string | null; weekly: number; sessions: number; no_summary: number; late: number; last_day: string | null }[]>;
  groupPendings(groupId: string): Promise<{ id: string; day: string; starts_at: string; subject_name: string; teacher_name: string | null; status: string }[]>;
  /** Substitui as presenças de uma aula já registada (correção). */
  replaceMarks(sessionId: string, marks: Mark[], actorId: string | null, now: Date): Promise<void>;
  teacherGroups(employeeId: string): Promise<(GroupRow & { subjects: string[] })[]>;
  groupSessions(groupId: string, teacherId?: string): Promise<SessionRow[]>;
  groupStudents(groupId: string): Promise<StudentSummaryRow[]>;
  yearGroups(yearId: string): Promise<GroupRow[]>;
  group(groupId: string): Promise<(GroupRow & { yearId: string }) | null>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
  history(sessionId: string): Promise<{ at: Date; type: string; actorName: string | null; details: { changes?: { studentId: string; fullName: string; before: PresenceStatus | null; after: PresenceStatus }[]; reason?: string | null } | null }[]>;
}
