import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type AttendanceError, attendanceError } from "./settings";

/**
 * OCORRÊNCIAS DOS PROFESSORES (área do RH): faltas e atrasos a uma aula (modelo "por aula")
 * ou ao dia (modelo "por dia"), marcadas pelo RH ou automáticas (política do colégio).
 *
 *   REGISTADA ──justificar──▶ JUSTIFICADA
 *       │  ▲                      │
 *     anular└──── reabrir ◀───────┘ (e ANULADA → reabrir → REGISTADA)
 *       ▼
 *   ANULADA          alterar (falta ↔ atraso, minutos): em REGISTADA ou JUSTIFICADA
 *
 * Cada passo pede o motivo e fica no histórico (quem, quando, antes → depois, motivo).
 */
export type OccurrenceScope = "LESSON" | "DAY";
export type OccurrenceKind = "FALTA" | "ATRASO";
export type OccurrenceSource = "MANUAL" | "AUTOMATIC";
export type OccurrenceStatus = "REGISTADA" | "JUSTIFICADA" | "ANULADA";

export const KIND_LABELS: Record<OccurrenceKind, string> = { FALTA: "Falta", ATRASO: "Atraso" };
export const STATUS_LABELS: Record<OccurrenceStatus, string> = { REGISTADA: "Por justificar", JUSTIFICADA: "Justificada", ANULADA: "Anulada" };
export const SOURCE_LABELS: Record<OccurrenceSource, string> = { MANUAL: "Marcada pelo RH", AUTOMATIC: "Automática · política do colégio" };

export type OccurrenceAction = "JUSTIFY" | "CHANGE" | "CANCEL" | "REOPEN";
const ALLOWED: Record<OccurrenceAction, OccurrenceStatus[]> = {
  JUSTIFY: ["REGISTADA"],
  CHANGE: ["REGISTADA", "JUSTIFICADA"],
  CANCEL: ["REGISTADA", "JUSTIFICADA"],
  REOPEN: ["JUSTIFICADA", "ANULADA"],
};
export const ACTION_LABELS: Record<OccurrenceAction | "CREATED", string> = { CREATED: "Registada", JUSTIFY: "Justificada", CHANGE: "Alterada", CANCEL: "Anulada", REOPEN: "Reaberta" };

/** As ações possíveis num estado (o portal só mostra estas). */
export const actionsFor = (s: OccurrenceStatus) => (Object.keys(ALLOWED) as OccurrenceAction[]).filter((a) => ALLOWED[a].includes(s));

export function canDo(action: OccurrenceAction, status: OccurrenceStatus): Result<void, AttendanceError> {
  return ALLOWED[action].includes(status) ? ok(undefined) : fail(attendanceError("INVALID_STATE", `Não é possível: a ocorrência está ${STATUS_LABELS[status].toLowerCase()}.`));
}

export const cleanText = (raw: string | null | undefined) => (raw ?? "").replace(/\s+/g, " ").trim();

export function checkReason(raw: string | null | undefined, what = "o motivo", max = 300): Result<string, AttendanceError> {
  const t = cleanText(raw);
  if (t.length < 3) return fail(attendanceError("INVALID_INPUT", `Indique ${what} (pelo menos 3 caracteres).`));
  if (t.length > max) return fail(attendanceError("INVALID_INPUT", `No máximo ${max} caracteres.`));
  return ok(t);
}

export function checkKind(kind: string, minutesLate?: number | null): Result<{ kind: OccurrenceKind; minutesLate: number | null }, AttendanceError> {
  if (kind === "FALTA") return ok({ kind, minutesLate: null });
  if (kind === "ATRASO") {
    if (!Number.isInteger(minutesLate) || (minutesLate as number) < 1 || (minutesLate as number) > 600) return fail(attendanceError("INVALID_INPUT", "Indique os minutos de atraso (1 a 600)."));
    return ok({ kind, minutesLate: minutesLate as number });
  }
  return fail(attendanceError("INVALID_INPUT", "Escolha falta ou atraso."));
}

/** "AAAA-MM-DD" de hoje no fuso do colégio. */
export const todayIn = (timeZone: string, now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * No modelo "por dia" a ocorrência espelha-se no registo diário do RH (employee_attendance):
 * falta → FALTA (ou FALTA_JUSTIFICADA com a justificação), atraso → ATRASO, anulada → PRESENTE.
 */
export function dailyMirror(o: { kind: OccurrenceKind; minutesLate: number | null; status: OccurrenceStatus; justification: string | null }) {
  if (o.status === "ANULADA") return { status: "PRESENTE", minutesLate: null, note: null };
  if (o.kind === "ATRASO") return { status: "ATRASO", minutesLate: o.minutesLate, note: o.status === "JUSTIFICADA" ? (o.justification ?? "").slice(0, 300) : null };
  return o.status === "JUSTIFICADA" ? { status: "FALTA_JUSTIFICADA", minutesLate: null, note: (o.justification ?? "").slice(0, 300) } : { status: "FALTA", minutesLate: null, note: null };
}
