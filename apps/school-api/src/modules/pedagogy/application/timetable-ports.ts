import type { Shift, YearStatus } from "../domain/academic";
import type { PeriodInput, PeriodKind, SubjectInput } from "../domain/timetable";

export interface SubjectRow {
  id: string;
  name: string;
  code: string;
  color: string;
  archivedAt: Date | null;
  /** classes (de todos os anos) com esta disciplina no plano */
  classCount: number;
  /** aulas marcadas em horários */
  lessonCount: number;
}

export interface PeriodRow {
  id: string;
  shift: Shift;
  position: number;
  startsAt: string;
  endsAt: string;
  kind: PeriodKind;
}

export interface CurriculumItem {
  subject: SubjectRow;
  weeklyPeriods: number;
}

/** Classe com o plano curricular e quantos tempos cada disciplina já tem no horário de cada turma. */
export interface ClassCurriculum {
  cls: { id: string; academicYearId: string; grade: number; course: string | null; courseCode: string | null; yearStatus: YearStatus; groups: { id: string; name: string; shift: Shift }[] };
  items: CurriculumItem[];
  /** subjectId → groupId → tempos marcados */
  scheduled: Record<string, Record<string, number>>;
}

export interface LessonRow {
  id: string;
  weekday: number;
  periodId: string;
  subjectId: string;
  teacherId: string | null;
  room: string | null;
}

export interface GroupTimetable {
  group: { id: string; name: string; shift: Shift; room: string | null; capacity: number | null; coordinator: { id: string; fullName: string } | null };
  /** professor de cada disciplina nesta turma (subjectId → professor) */
  teachers: Record<string, { id: string; fullName: string }>;
  /** aulas desta turma em que o professor tem outra aula à mesma hora (lessonId → onde) */
  clashes: Record<string, string>;
  cls: { id: string; grade: number; course: string | null; courseCode: string | null };
  year: { id: string; name: string; status: YearStatus };
  periods: PeriodRow[];
  lessons: LessonRow[];
  curriculum: CurriculumItem[];
}

export type SubjectOutcome<T> = { ok: true; value: T } | { ok: false; reason: "name_taken" | "code_taken" | "not_found" | "in_use" };

export type TimetableOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "closed" | "slot_invalid" | "not_in_curriculum" }
  | { ok: false; reason: "weekly_limit"; limit: number }
  | { ok: false; reason: "room_busy"; room: string; by: string }
  | { ok: false; reason: "teacher_busy"; teacher: string; by: string }
  | { ok: false; reason: "in_lessons"; subjectId: string; count: number }
  | { ok: false; reason: "period_in_use"; position: number; count: number };

/** Disciplinas, planos curriculares, tempos letivos e horários — na BD do PRÓPRIO colégio. */
export interface TimetableRepository {
  listSubjects(): Promise<SubjectRow[]>;
  findSubject(id: string): Promise<SubjectRow | null>;
  createSubject(input: SubjectInput & { id: string; now: Date }): Promise<SubjectOutcome<SubjectRow>>;
  updateSubject(id: string, input: SubjectInput & { now: Date }): Promise<SubjectOutcome<SubjectRow>>;
  setSubjectArchived(id: string, archived: boolean, now: Date): Promise<SubjectOutcome<SubjectRow>>;
  /** Só se não estiver em nenhum plano nem horário. */
  deleteSubject(id: string): Promise<SubjectOutcome<void>>;

  /** Resumo dos planos do ano: por classe, nº de disciplinas e total de tempos. */
  yearCurricula(yearId: string): Promise<{ classId: string; subjects: number; weeklyPeriods: number }[]>;
  classCurriculum(classId: string): Promise<ClassCurriculum | null>;
  /** Substitui o plano da classe. Recusa retirar disciplinas que já estão no horário, ou baixar tempos abaixo dos marcados. */
  setCurriculum(classId: string, items: { subjectId: string; weeklyPeriods: number }[], now: Date): Promise<TimetableOutcome<void>>;

  /** Tempos do turno (cria os de omissão na primeira vez). */
  periods(shift: Shift, now: Date): Promise<PeriodRow[]>;
  /** Substitui os tempos do turno (mantém os ids por posição; não apaga nem torna intervalo um tempo com aulas). */
  setPeriods(shift: Shift, items: PeriodInput[], now: Date): Promise<TimetableOutcome<PeriodRow[]>>;

  groupTimetable(groupId: string, now: Date): Promise<GroupTimetable | null>;
  /** Aulas marcadas por turma no ano (para o progresso dos horários). */
  yearTimetables(yearId: string): Promise<{ groupId: string; scheduled: number }[]>;
  /** Marca (ou limpa, com subjectId null) uma aula. Valida o plano, os tempos semanais e a sala. */
  setLesson(input: { id: string; groupId: string; weekday: number; periodId: string; subjectId: string | null; room: string | null; now: Date }): Promise<TimetableOutcome<LessonRow | null>>;
}
