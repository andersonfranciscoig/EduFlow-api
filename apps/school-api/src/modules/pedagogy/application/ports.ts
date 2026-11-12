import type { Shift, YearStatus } from "../domain/academic";

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
}

export interface ClassRow {
  id: string;
  academicYearId: string;
  grade: number;
  course: string | null;
  groups: GroupRow[];
}

/** Resultado de escritas com regras que só a BD garante de forma atómica. */
export type WriteOutcome<T> = { ok: true; value: T } | { ok: false; reason: "overlap" | "name_taken" | "active_exists" | "duplicate" | "not_found" | "closed" };

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
  addClass(input: { id: string; academicYearId: string; grade: number; course: string | null; now: Date }): Promise<WriteOutcome<ClassRow>>;
  findClass(id: string): Promise<(ClassRow & { yearStatus: YearStatus }) | null>;
  removeClass(id: string): Promise<void>;
  addGroup(input: { id: string; classId: string; academicYearId: string; name: string; shift: Shift; room: string | null; capacity: number | null; now: Date }): Promise<WriteOutcome<GroupRow>>;
  findGroup(id: string): Promise<(GroupRow & { yearStatus: YearStatus }) | null>;
  updateGroup(id: string, input: { name: string; shift: Shift; room: string | null; capacity: number | null; now: Date }): Promise<WriteOutcome<GroupRow>>;
  removeGroup(id: string): Promise<void>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

/** Quem está a pedir (vem do SchoolAuthGuard). */
export interface PedagogyActor {
  id: string;
  role: string;
  isOwner: boolean;
  support?: { mode: "READ" | "WRITE" };
}
