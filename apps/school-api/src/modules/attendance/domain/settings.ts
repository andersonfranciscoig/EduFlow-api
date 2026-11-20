import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * REGRAS DE ASSIDUIDADE do colégio (uma configuração):
 *  - modelo dos professores: por aula (cada aula conta) ou por dia (um registo diário:
 *    presente se submeteu as presenças de pelo menos uma aula prevista);
 *  - procedimento quando o professor não submete as presenças no prazo: manual (o RH decide)
 *    ou automático (fica registada uma ocorrência — política do colégio, que o RH pode corrigir);
 *  - prazo (minutos depois do fim da aula), limites dos alertas e o fuso horário.
 */
export type TeacherModel = "PER_LESSON" | "PER_DAY";
export type MissingProcedure = "MANUAL" | "AUTOMATIC";

export const TEACHER_MODELS: Record<TeacherModel, { label: string; hint: string }> = {
  PER_LESSON: { label: "Por aula", hint: "Cada aula conta: a presença e a submissão das presenças são controladas aula a aula." },
  PER_DAY: { label: "Por dia", hint: "Um registo por dia de trabalho: presente se submeteu as presenças de pelo menos uma aula prevista." },
};
export const MISSING_PROCEDURES: Record<MissingProcedure, { label: string; hint: string }> = {
  MANUAL: { label: "Gestão manual", hint: "A aula fica pendente e o RH é avisado: analisa e decide se regista falta ou se há justificação." },
  AUTOMATIC: {
    label: "Gestão automática",
    hint: "Passado o prazo, fica registada uma ocorrência de falta ao professor e o RH é avisado. É uma política do colégio: não submeter não quer dizer que faltou — o RH pode rever e corrigir.",
  },
};

/** Fusos horários propostos (Angola por omissão); qualquer outro válido também é aceite. */
export const TIME_ZONES = ["Africa/Luanda", "Africa/Maputo", "Africa/Lagos", "Africa/Johannesburg", "Atlantic/Cape_Verde", "Africa/Bissau", "Africa/Sao_Tome", "Europe/Lisbon"];

export interface AttendanceRules {
  teacherModel: TeacherModel;
  missingProcedure: MissingProcedure;
  deadlineMinutes: number;
  absenceLimit: number;
  consecutiveLimit: number;
  timeZone: string;
  /** "AAAA-MM-DD": a partir deste dia o controlo automático do prazo conta (null = ainda por fixar: hoje) */
  trackingSince: string | null;
}

export const DEFAULT_RULES: AttendanceRules = { teacherModel: "PER_LESSON", missingProcedure: "MANUAL", deadlineMinutes: 60, absenceLimit: 10, consecutiveLimit: 3, timeZone: "Africa/Luanda", trackingSince: null };

export type AttendanceErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "OCCURRENCE_EXISTS" | "NO_CLASSES" | "DEADLINE_PASSED";
export type AttendanceError = DomainError<AttendanceErrorCode>;
export const attendanceError = (code: AttendanceErrorCode, message: string, meta?: Record<string, unknown>): AttendanceError => new DomainError(code, message, meta);

const validZone = (z: string) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

export function checkRules(input: AttendanceRules): Result<AttendanceRules, AttendanceError> {
  if (!(input.teacherModel in TEACHER_MODELS)) return fail(attendanceError("INVALID_INPUT", "Escolha o modelo de assiduidade dos professores."));
  if (!(input.missingProcedure in MISSING_PROCEDURES)) return fail(attendanceError("INVALID_INPUT", "Escolha o procedimento."));
  if (!Number.isInteger(input.deadlineMinutes) || input.deadlineMinutes < 30 || input.deadlineMinutes > 240) return fail(attendanceError("INVALID_INPUT", "O prazo tem de ser entre 30 minutos e 4 horas."));
  if (!Number.isInteger(input.absenceLimit) || input.absenceLimit < 1 || input.absenceLimit > 200) return fail(attendanceError("INVALID_INPUT", "O limite de faltas tem de ser entre 1 e 200."));
  if (!Number.isInteger(input.consecutiveLimit) || input.consecutiveLimit < 2 || input.consecutiveLimit > 30) return fail(attendanceError("INVALID_INPUT", "As faltas seguidas têm de ser entre 2 e 30."));
  if (!validZone(input.timeZone)) return fail(attendanceError("INVALID_INPUT", "Fuso horário desconhecido."));
  if (input.trackingSince !== null) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(input.trackingSince) ? new Date(`${input.trackingSince}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.trackingSince) return fail(attendanceError("INVALID_INPUT", "Data de início do controlo inválida."));
  }
  return ok(input);
}

/** O que mudou (para o histórico): só os campos alterados, antes → depois. */
export function diffRules(before: AttendanceRules, after: AttendanceRules) {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(after) as (keyof AttendanceRules)[]) if (before[k] !== after[k]) out[k] = { before: before[k], after: after[k] };
  return out;
}
