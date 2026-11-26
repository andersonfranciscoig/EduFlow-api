import type { ClosureKind, PeriodKind } from "../domain/calendar";
import type { YearStatus } from "../domain/academic";

export interface CalendarYearRow {
  id: string;
  name: string;
  startsOn: Date;
  endsOn: Date;
  status: YearStatus;
  periodKind: PeriodKind;
}
export interface PeriodRow {
  position: number;
  startsOn: Date;
  endsOn: Date;
}
export interface ClosureRow {
  id: string;
  academicYearId: string;
  startsOn: Date;
  endsOn: Date;
  kind: ClosureKind;
  reason: string;
  createdAt: Date;
}

/** Calendário escolar (períodos de avaliação e dias sem aulas) de cada ano letivo. */
export interface CalendarRepository {
  year(id: string): Promise<CalendarYearRow | null>;
  periods(yearId: string): Promise<PeriodRow[]>;
  closures(yearId: string): Promise<ClosureRow[]>;
  findClosure(id: string): Promise<(ClosureRow & { yearStatus: YearStatus }) | null>;
  /** Substitui os períodos do ano e o tipo (trimestres/semestres) — numa transação. */
  setPeriods(yearId: string, kind: PeriodKind, items: PeriodRow[], now: Date): Promise<void>;
  /** O ano já tem avaliações na caderneta? (então não se muda de trimestres para semestres) */
  yearHasGrades(yearId: string): Promise<boolean>;
  /** Acrescenta, se não se sobrepuser a outro intervalo do mesmo ano (false = sobrepõe-se). */
  addClosure(input: Omit<ClosureRow, "createdAt"> & { createdById: string | null; now: Date }): Promise<boolean>;
  removeClosure(id: string): Promise<void>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}
