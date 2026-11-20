import type { OccurrenceKind, OccurrenceScope, OccurrenceSource, OccurrenceStatus } from "../domain/occurrences";

export interface TeacherRow {
  id: string;
  fullName: string;
  number: number | null;
  weeklyLessons: number;
  open: number;
  justified: number;
}

export interface PlanLesson {
  id: string;
  startsAt: string;
  endsAt: string;
  groupName: string;
  subjectName: string;
}

export interface OccurrenceRow {
  id: string;
  employeeId: string;
  teacherName: string;
  day: string;
  scope: OccurrenceScope;
  lessonId: string | null;
  groupName: string | null;
  subjectName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  kind: OccurrenceKind;
  minutesLate: number | null;
  source: OccurrenceSource;
  status: OccurrenceStatus;
  note: string | null;
  justification: string | null;
  createdAt: Date;
  createdByName: string | null;
  updatedAt: Date;
}

export interface NewOccurrence {
  id: string;
  employeeId: string;
  day: string;
  scope: OccurrenceScope;
  lesson: PlanLesson | null;
  kind: OccurrenceKind;
  minutesLate: number | null;
  source: OccurrenceSource;
  note: string | null;
}

export interface HistoryRow {
  at: Date;
  type: string;
  actorName: string | null;
  details: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; reason?: string | null } | null;
}

export interface OccurrenceFilter {
  employeeId?: string;
  status?: OccurrenceStatus;
  source?: OccurrenceSource;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface OccurrencesRepository {
  teacher(employeeId: string): Promise<{ id: string; fullName: string; number: number | null } | null>;
  /** Professores com aulas no horário (anos não encerrados), com as ocorrências por justificar e justificadas. */
  teachers(): Promise<TeacherRow[]>;
  /** O ano letivo que contém o dia (o em curso primeiro). */
  yearOn(day: string): Promise<{ id: string; name: string } | null>;
  closureOn(yearId: string, day: string): Promise<{ kindLabel: string; reason: string } | null>;
  /** As aulas do professor nesse dia da semana, no ano. */
  lessonsOn(employeeId: string, yearId: string, day: string): Promise<PlanLesson[]>;
  onDay(employeeId: string, day: string): Promise<OccurrenceRow[]>;
  /** Cria todas ou nenhuma (false = já há uma ativa para essa aula/dia). */
  create(items: NewOccurrence[], actorId: string | null, now: Date): Promise<boolean>;
  find(id: string): Promise<OccurrenceRow | null>;
  list(f: OccurrenceFilter): Promise<{ total: number; items: OccurrenceRow[] }>;
  counts(): Promise<{ open: number; justified: number; cancelled: number; automatic: number }>;
  /** Grava o novo estado (false = outra ativa já ocupa a aula/dia, ao reabrir). */
  update(id: string, patch: { kind: OccurrenceKind; minutesLate: number | null; status: OccurrenceStatus; justification: string | null }, actorId: string | null, now: Date): Promise<boolean>;
  /** Modelo "por dia": o registo diário do RH acompanha a ocorrência. */
  mirrorDaily(employeeId: string, day: string, rec: { status: string; minutesLate: number | null; note: string | null }, actorId: string | null, now: Date): Promise<void>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
  history(id: string): Promise<HistoryRow[]>;
}
