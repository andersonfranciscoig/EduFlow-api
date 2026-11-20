import type { Shift, YearStatus } from "../domain/academic";
import type { Qualification, QualificationData } from "../domain/qualifications";

export interface TeacherRef {
  id: string;
  fullName: string;
}

export interface TeacherCandidate extends TeacherRef {
  number: number | null;
  typeName: string | null;
  jobTitle: string | null;
  status: string;
  hasPortal: boolean;
}

export interface GroupTeaching {
  group: { id: string; name: string; shift: Shift; room: string | null; coordinator: TeacherRef | null };
  cls: { id: string; grade: number; courseId: string | null; course: string | null; courseCode: string | null };
  year: { id: string; name: string; status: YearStatus };
  subjects: { subject: { id: string; name: string; code: string; color: string }; weeklyPeriods: number; scheduled: number; teacher: TeacherRef | null }[];
}

/** Uma aula de um professor, com as horas e a turma (o horário do professor e os choques). */
export interface TeacherLesson {
  id: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  position: number;
  shift: Shift;
  groupId: string;
  groupName: string;
  grade: number;
  courseCode: string | null;
  subject: { id: string; name: string; code: string; color: string };
  room: string | null;
}

export interface TeacherLoad extends TeacherCandidate {
  /** pares turma/disciplina atribuídos */
  assignments: number;
  /** tempos por semana pelo plano curricular */
  weeklyPeriods: number;
  /** aulas já marcadas nos horários */
  scheduled: number;
  coordinates: { id: string; label: string }[];
}

/** Uma turma onde o professor dá aulas ou que coordena (para "As minhas turmas"). */
export interface TeacherGroup {
  id: string;
  name: string;
  label: string;
  grade: number;
  course: string | null;
  courseCode: string | null;
  shift: Shift;
  room: string | null;
  coordinator: TeacherRef | null;
  isCoordinator: boolean;
  /** disciplinas do plano da classe */
  planSubjects: number;
  /** alunos matriculados (ativos) na turma */
  students: number;
  /** as disciplinas que ele dá nesta turma, com os tempos do plano e as aulas já marcadas */
  subjects: { subject: { id: string; name: string; code: string; color: string }; weeklyPeriods: number; scheduled: number }[];
}

export type TeachingOutcome<T = void> = { ok: true; value: T } | { ok: false; reason: "not_found" | "closed" | "not_in_curriculum" | "teacher_invalid" | "taken" };

export interface QualificationCatalog {
  courses: { id: string; name: string; code: string | null; archived: boolean }[];
  subjects: { id: string; name: string; code: string; color: string; archived: boolean }[];
}

/** Uma turma do ano, para as propostas automáticas. */
export interface YearPlanGroup {
  id: string;
  label: string;
  grade: number;
  courseId: string | null;
  coordinatorId: string | null;
  subjects: { subjectId: string; weeklyPeriods: number; teacherId: string | null }[];
  lessons: { subjectId: string; teacherId: string | null; weekday: number; startsAt: string; endsAt: string }[];
}

/** Professores (na BD do PRÓPRIO colégio). */
export interface TeachingRepository {
  /** O ano letivo em curso (ou o mais recente). */
  currentYearId(): Promise<string | null>;
  groupTeaching(groupId: string): Promise<GroupTeaching | null>;
  candidates(): Promise<TeacherCandidate[]>;
  findTeacher(employeeId: string): Promise<TeacherCandidate | null>;
  employeeOfUser(userId: string): Promise<TeacherCandidate | null>;
  /** Atribui (ou retira, com null) o professor da disciplina na turma; as aulas já marcadas passam a ser dele. */
  /** onlyIfEmpty: não substitui um professor já atribuído ("taken"). */
  assign(input: { groupId: string; subjectId: string; employeeId: string | null; actorId: string | null; now: Date; onlyIfEmpty?: boolean }): Promise<TeachingOutcome>;
  setCoordinator(groupId: string, employeeId: string | null, now: Date, onlyIfEmpty?: boolean): Promise<TeachingOutcome>;
  qualifications(employeeId: string): Promise<Qualification[]>;
  allQualifications(): Promise<(Qualification & { employeeId: string })[]>;
  qualificationCatalog(): Promise<QualificationCatalog>;
  /** Cria (sem id) ou altera uma habilitação do professor; false se não existir. */
  saveQualification(input: { id?: string; employeeId: string; data: QualificationData; now: Date }): Promise<string | null>;
  deleteQualification(employeeId: string, id: string): Promise<boolean>;
  yearPlan(yearId: string): Promise<YearPlanGroup[]>;
  /** As turmas do ano onde o professor dá aulas ou que coordena. */
  teacherGroups(employeeId: string, yearId: string): Promise<TeacherGroup[]>;
  /** O professor dá aulas nesta turma (disciplinas) ou coordena-a? null se nenhum dos dois. */
  groupAccess(employeeId: string, groupId: string): Promise<{ subjectIds: string[]; coordinates: boolean } | null>;
  teacherLessons(employeeId: string, yearId: string): Promise<TeacherLesson[]>;
  loads(yearId: string): Promise<TeacherLoad[]>;
  yearInfo(yearId: string): Promise<{ id: string; name: string; status: YearStatus } | null>;
}
