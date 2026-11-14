import type { Shift, YearStatus } from "../domain/academic";

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
  cls: { id: string; grade: number; course: string | null; courseCode: string | null };
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

export type TeachingOutcome<T = void> = { ok: true; value: T } | { ok: false; reason: "not_found" | "closed" | "not_in_curriculum" | "teacher_invalid" };

/** Professores (na BD do PRÓPRIO colégio). */
export interface TeachingRepository {
  /** O ano letivo em curso (ou o mais recente). */
  currentYearId(): Promise<string | null>;
  groupTeaching(groupId: string): Promise<GroupTeaching | null>;
  candidates(): Promise<TeacherCandidate[]>;
  findTeacher(employeeId: string): Promise<TeacherCandidate | null>;
  employeeOfUser(userId: string): Promise<TeacherCandidate | null>;
  /** Atribui (ou retira, com null) o professor da disciplina na turma; as aulas já marcadas passam a ser dele. */
  assign(input: { groupId: string; subjectId: string; employeeId: string | null; actorId: string | null; now: Date }): Promise<TeachingOutcome>;
  setCoordinator(groupId: string, employeeId: string | null, now: Date): Promise<TeachingOutcome>;
  teacherLessons(employeeId: string, yearId: string): Promise<TeacherLesson[]>;
  loads(yearId: string): Promise<TeacherLoad[]>;
  yearInfo(yearId: string): Promise<{ id: string; name: string; status: YearStatus } | null>;
}
