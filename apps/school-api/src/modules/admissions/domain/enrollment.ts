/**
 * MATRÍCULAS (fase E).
 *   quem confirma   STAFF — a secretaria (por omissão)
 *                   FAMILY — a família (encarregado ou aluno maior) confirma na área da família
 *                   AUTO — a matrícula faz-se sozinha ao aprovar a inscrição (se houver vaga)
 *   vaga            ao aprovar guarda-se uma vaga na classe (reserva) até ao fim do período de
 *                   matrículas (ou N dias); ao matricular, a vaga confirma-se numa turma com lugar.
 *                   A classe bloqueia-se na transação: duas matrículas não ficam com a última vaga.
 *   exceção         sem vaga, só com a permissão própria e um motivo (fica registado)
 *   n.º             único por ano: <prefixo>-<ano>-<sequência>, configurável (ex.: MAT-2026-00001)
 *   n.º de aluno    permanente, dado na primeira matrícula
 */
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type AdmissionError, admissionError } from "./settings";

export const ENROLLMENT_MODES = {
  STAFF: { label: "Pela secretaria", hint: "Depois de aprovar, a secretaria confirma a matrícula e escolhe a turma." },
  FAMILY: { label: "Pela família", hint: "Depois de aprovada, a família (encarregado ou aluno maior) confirma a matrícula na área da família." },
  AUTO: { label: "Automática ao aprovar", hint: "Ao aprovar a inscrição, a matrícula faz-se logo, numa turma com lugar." },
} as const;
export type EnrollmentMode = keyof typeof ENROLLMENT_MODES;
export const isEnrollmentMode = (m: unknown): m is EnrollmentMode => typeof m === "string" && m in ENROLLMENT_MODES;

export interface EnrollmentConfig {
  enrollmentMode: EnrollmentMode;
  numberPrefix: string;
  numberWithYear: boolean;
  numberDigits: number;
  holdDays: number;
}

export const DEFAULT_CONFIG: EnrollmentConfig = { enrollmentMode: "STAFF", numberPrefix: "MAT", numberWithYear: true, numberDigits: 5, holdDays: 15 };

export function checkConfig(input: Partial<EnrollmentConfig>): Result<EnrollmentConfig, AdmissionError> {
  if (!isEnrollmentMode(input.enrollmentMode)) return fail(admissionError("INVALID_INPUT", "Escolha quem confirma a matrícula."));
  const prefix = (input.numberPrefix ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{0,8}$/.test(prefix)) return fail(admissionError("INVALID_INPUT", "O prefixo tem até 8 letras ou algarismos (sem espaços)."));
  const digits = Number(input.numberDigits);
  if (!Number.isInteger(digits) || digits < 3 || digits > 8) return fail(admissionError("INVALID_INPUT", "A sequência tem de 3 a 8 algarismos."));
  const hold = Number(input.holdDays);
  if (!Number.isInteger(hold) || hold < 1 || hold > 90) return fail(admissionError("INVALID_INPUT", "A vaga fica guardada de 1 a 90 dias."));
  return ok({ enrollmentMode: input.enrollmentMode, numberPrefix: prefix, numberWithYear: !!input.numberWithYear, numberDigits: digits, holdDays: hold });
}

/** N.º de matrícula: prefixo, ano (o de início do ano letivo) e a sequência do ano. */
export function formatEnrollmentNumber(cfg: Pick<EnrollmentConfig, "numberPrefix" | "numberWithYear" | "numberDigits">, yearStart: string, seq: number) {
  return [cfg.numberPrefix || null, cfg.numberWithYear ? yearStart.slice(0, 4) : null, String(seq).padStart(cfg.numberDigits, "0")].filter(Boolean).join("-");
}

/** N.º de aluno como aparece (permanente). */
export const formatStudentNumber = (n: number | null) => (n ? String(n).padStart(5, "0") : null);

export const ENROLLMENT_BY = { STAFF: "Secretaria", FAMILY: "Família", AUTO: "Automática (ao aprovar)" } as const;
