import type { Shift, YearStatus } from "../domain/academic";
import type { CourseKind } from "../domain/courses";
import type { ReservationStatus } from "../domain/seats";

export interface YearRow {
  id: string;
  name: string;
  startsOn: Date;
  endsOn: Date;
  status: YearStatus;
  activatedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

export interface YearSummaryRow extends YearRow {
  classes: number;
  groups: number;
  capacity: number;
}

export interface GroupRow {
  id: string;
  classId: string;
  academicYearId: string;
  name: string;
  shift: Shift;
  room: string | null;
  capacity: number | null;
  /** alunos já colocados nesta turma (reservas confirmadas) */
  confirmed: number;
  /** coordenador de turma (null = por definir) */
  coordinator: { id: string; fullName: string } | null;
  /** aulas já marcadas no horário */
  scheduled: number;
}

export interface ClassRow {
  id: string;
  academicYearId: string;
  grade: number;
  /** curso do catálogo (II Ciclo) */
  courseId: string | null;
  /** nome do curso (vem do catálogo) */
  course: string | null;
  courseCode: string | null;
  description: string | null;
  /** vagas definidas pela direção (null = usar os lugares) */
  vacanciesSet: number | null;
  /** reservas no prazo (inscrições em curso) */
  held: number;
  groups: GroupRow[];
}

export interface ReservationRow {
  id: string;
  academicYearId: string;
  classId: string;
  groupId: string | null;
  status: ReservationStatus;
  reference: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface CourseRow {
  id: string;
  name: string;
  code: string | null;
  kind: CourseKind;
  description: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  /** classes que usam o curso (todos os anos) */
  classCount: number;
}

export type CourseOutcome<T> = { ok: true; value: T } | { ok: false; reason: "name_taken" | "code_taken" | "not_found" | "in_use" };

/** Resultado de escritas com regras que só a BD garante de forma atómica. */
export type WriteOutcome<T> = { ok: true; value: T } | { ok: false; reason: "overlap" | "name_taken" | "active_exists" | "duplicate" | "not_found" | "closed" };

/** Escritas que mexem nas vagas (feitas com a linha da classe bloqueada). */
export type SeatOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_found" | "closed" | "duplicate" | "invalid_group" | "group_full" | "not_held" }
  | { ok: false; reason: "no_vacancy"; available: number }
  | { ok: false; reason: "seats_taken"; taken: number; inGroup?: number }
  | { ok: false; reason: "above_capacity"; capacity: number };

/** Dados pedagógicos — na BD do PRÓPRIO colégio. */
export interface PedagogyRepository {
  listYears(): Promise<YearSummaryRow[]>;
  findYear(id: string): Promise<YearRow | null>;
  structure(yearId: string): Promise<ClassRow[]>;
  /** Cria o ano (sem sobreposição de datas, nome livre) e, se pedido, copia classes e turmas de outro ano — tudo numa transação. */
  createYear(input: { id: string; name: string; startsOn: Date; endsOn: Date; createdById: string | null; copyFromYearId: string | null; now: Date }): Promise<WriteOutcome<YearRow>>;
  updateYear(id: string, input: { name: string; startsOn: Date; endsOn: Date; now: Date }): Promise<WriteOutcome<YearRow>>;
  /** Muda o estado só se o atual for `from` (sem corridas). */
  setStatus(id: string, from: YearStatus, to: YearStatus, now: Date): Promise<WriteOutcome<YearRow>>;
  deleteYear(id: string): Promise<void>;
  addClass(input: { id: string; academicYearId: string; grade: number; courseId: string | null; description: string | null; now: Date }): Promise<WriteOutcome<ClassRow>>;
  findClass(id: string): Promise<(ClassRow & { yearStatus: YearStatus }) | null>;
  removeClass(id: string): Promise<void>;
  addGroup(input: { id: string; classId: string; academicYearId: string; name: string; shift: Shift; room: string | null; capacity: number | null; now: Date }): Promise<WriteOutcome<GroupRow>>;
  findGroup(id: string): Promise<(GroupRow & { yearStatus: YearStatus }) | null>;
  /** A lotação nunca fica abaixo dos alunos da turma nem das vagas já tomadas na classe. */
  updateGroup(id: string, input: { name: string; shift: Shift; room: string | null; capacity: number | null; now: Date }): Promise<SeatOutcome<GroupRow>>;
  /** Só se a turma não tiver alunos e as vagas tomadas couberem nas restantes turmas. */
  removeGroup(id: string): Promise<SeatOutcome<void>>;

  // ---- vagas (todas com a linha da classe bloqueada: nunca acima do limite)
  setVacancies(classId: string, value: number | null, now: Date): Promise<SeatOutcome<void>>;
  holdSeat(input: { id: string; classId: string; reference: string; expiresAt: Date; now: Date }): Promise<SeatOutcome<ReservationRow>>;
  confirmSeat(input: { reservationId: string; groupId: string | null; now: Date }): Promise<SeatOutcome<ReservationRow>>;
  releaseSeat(reservationId: string, now: Date): Promise<SeatOutcome<ReservationRow>>;
  findReservation(id: string): Promise<(ReservationRow & { yearStatus: YearStatus }) | null>;

  // ---- cursos (catálogo do colégio)
  listCourses(): Promise<CourseRow[]>;
  findCourse(id: string): Promise<CourseRow | null>;
  createCourse(input: { id: string; name: string; code: string | null; kind: CourseKind; description: string | null; now: Date }): Promise<CourseOutcome<CourseRow>>;
  updateCourse(id: string, input: { name: string; code: string | null; kind: CourseKind; description: string | null; now: Date }): Promise<CourseOutcome<CourseRow>>;
  setCourseArchived(id: string, archived: boolean, now: Date): Promise<CourseOutcome<CourseRow>>;
  /** Só se nenhuma classe (de nenhum ano) o usar. */
  deleteCourse(id: string): Promise<CourseOutcome<void>>;
  /** Classes do curso em todos os anos letivos (com turmas e vagas). */
  courseClasses(courseId: string): Promise<(ClassRow & { year: YearRow })[]>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

/** Quem está a pedir (vem do SchoolAuthGuard). */
export interface PedagogyActor {
  id: string;
  role: string;
  isOwner: boolean;
  support?: { mode: "READ" | "WRITE" };
}
