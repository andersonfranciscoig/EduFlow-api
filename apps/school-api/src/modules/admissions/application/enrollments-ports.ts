import type { EnrollmentConfig } from "../domain/enrollment";

export interface GroupSeats {
  id: string;
  name: string;
  shift: "MANHA" | "TARDE" | "NOITE";
  capacity: number | null;
  confirmed: number;
}

/** As vagas da classe de uma inscrição aprovada (para confirmar a matrícula). */
export interface ClassSeats {
  classId: string;
  vacancies: number;
  held: number;
  confirmed: number;
  available: number;
  groups: GroupSeats[];
  /** a vaga guardada para esta inscrição (se ainda estiver guardada) */
  heldForApplication: { id: string; expiresAt: Date | null; expired: boolean } | null;
}

export interface EnrollmentRow {
  id: string;
  number: string;
  studentId: string;
  studentNumber: number | null;
  studentName: string;
  applicationId: string | null;
  applicationNumber: string | null;
  academicYearId: string;
  yearName: string;
  yearStart: string;
  classId: string;
  grade: number;
  courseName: string | null;
  groupId: string | null;
  groupName: string | null;
  shift: "MANHA" | "TARDE" | "NOITE" | null;
  status: "ACTIVE" | "CANCELLED";
  byKind: "STAFF" | "FAMILY" | "AUTO";
  byName: string | null;
  exceptionReason: string | null;
  enrolledAt: Date;
  /** o encarregado principal (para o comprovativo) */
  guardianName: string | null;
  accountId: string | null;
}

export type EnrollOutcome =
  | { ok: true; enrollment: EnrollmentRow }
  | { ok: false; reason: "not_approved" | "already_enrolled" | "no_vacancy" | "group_full" | "invalid_group" | "year_closed" | "no_groups" };

export type HoldOutcome = { ok: true; id: string; expiresAt: Date } | { ok: false; reason: "no_vacancy" | "year_closed" | "not_found" };

/** Fees da classe (preçário), só para mostrar na confirmação. */
export interface ClassFeeRow {
  name: string;
  billing: "MENSAL" | "UNICA";
  appliesTo: "TODOS" | "NOVOS" | "CONTINUANTES";
  amount: number;
}

export interface EnrollmentsRepository {
  config(): Promise<EnrollmentConfig>;
  saveConfig(cfg: EnrollmentConfig, actorId: string | null, now: Date): Promise<void>;
  /** Próximo n.º do ano (sem o gastar), para pré-visualizar. */
  nextSequence(academicYearId: string): Promise<number>;
  /** O fim do período de matrículas do ano (AAAA-MM-DD) ou null. */
  enrollmentsEnd(academicYearId: string): Promise<string | null>;
  /** Guarda uma vaga para a inscrição (bloqueia a classe). */
  holdForApplication(input: { applicationId: string; classId: string; reference: string; expiresAt: Date; now: Date }): Promise<HoldOutcome>;
  /** Liberta a vaga guardada (inscrição rejeitada/cancelada). */
  releaseForApplication(applicationId: string, now: Date): Promise<void>;
  seats(applicationId: string, now: Date): Promise<ClassSeats | null>;
  fees(classId: string): Promise<ClassFeeRow[]>;
  /**
   * Matricula numa transação: bloqueia a inscrição e a classe, confirma a vaga (a guardada ou uma
   * livre; numa exceção, mesmo sem vaga) numa turma, dá o n.º de matrícula do ano e o n.º de aluno.
   */
  enroll(input: {
    applicationId: string;
    groupId: string | null;
    exceptionReason: string | null;
    by: { kind: "STAFF" | "FAMILY" | "AUTO"; id: string | null; name: string | null };
    cfg: EnrollmentConfig;
    now: Date;
  }): Promise<EnrollOutcome>;
  byApplication(applicationId: string): Promise<EnrollmentRow | null>;
  byId(id: string): Promise<EnrollmentRow | null>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}
