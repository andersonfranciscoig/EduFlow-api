/**
 * ASSIDUIDADE DOS FUNCIONÁRIOS (registada pelo RH, dia a dia).
 *   estados     PRESENTE · ATRASO (com os minutos) · FALTA · FALTA_JUSTIFICADA (com o motivo)
 *               sem registo = por marcar
 *   quem        os funcionários ativos (e quem já tiver registo nesse dia, para corrigir)
 *   quando      até hoje (hora de Luanda) e no máximo um ano para trás
 *   comprovativo  opcional, nunca numa presença
 */
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { addDays, daysBetween } from "./contracts";
import { isIsoDate } from "./employee";
import { type HrError, hrError } from "./form";

export const ATTENDANCE_STATUSES = {
  PRESENTE: { label: "Presente", code: "P" },
  ATRASO: { label: "Atraso", code: "A" },
  FALTA: { label: "Falta", code: "F" },
  FALTA_JUSTIFICADA: { label: "Falta justificada", code: "J" },
} as const;
export type AttendanceStatus = keyof typeof ATTENDANCE_STATUSES;
export const ATTENDANCE_STATUS_KEYS = Object.keys(ATTENDANCE_STATUSES) as AttendanceStatus[];
export const isAttendanceStatus = (s: string): s is AttendanceStatus => s in ATTENDANCE_STATUSES;

/** Quem aparece na folha do dia (além de quem já tem registo nesse dia). */
export const ATTENDANCE_EMPLOYEES = ["ACTIVE"] as const;
/** Até quantos dias para trás se marca/corrige. */
export const MAX_DAYS_BACK = 366;
export const MAX_MINUTES_LATE = 600;

export interface AttendanceEntry {
  employeeId: string;
  /** null = limpar (volta a "por marcar") */
  status: AttendanceStatus | null;
  minutesLate: number | null;
  note: string | null;
}

/** A data pode ser marcada? (nem no futuro, nem há mais de um ano) */
export function checkDay(day: string, today: string): Result<string, HrError> {
  if (!isIsoDate(day)) return fail(hrError("INVALID_INPUT", "Data inválida."));
  if (day > today) return fail(hrError("INVALID_INPUT", "Não se marca a assiduidade de um dia que ainda não chegou."));
  if (daysBetween(day, today) > MAX_DAYS_BACK) return fail(hrError("INVALID_INPUT", "Só se marca a assiduidade até um ano para trás."));
  return ok(day);
}

/** Valida uma linha da folha (o nome serve para a mensagem de erro). */
export function checkEntry(raw: { employeeId: string; status: string | null; minutesLate?: number | null; note?: string | null }, name: string): Result<AttendanceEntry, HrError> {
  const note = raw.note?.replace(/\s+/g, " ").trim() || null;
  if (raw.status === null) return ok({ employeeId: raw.employeeId, status: null, minutesLate: null, note: null });
  if (!isAttendanceStatus(raw.status)) return fail(hrError("INVALID_INPUT", `${name}: estado inválido.`));
  if (note && note.length > 300) return fail(hrError("INVALID_INPUT", `${name}: a nota tem no máximo 300 caracteres.`));
  if (raw.status === "ATRASO") {
    const m = raw.minutesLate;
    if (m == null || !Number.isInteger(m) || m < 1 || m > MAX_MINUTES_LATE) return fail(hrError("INVALID_INPUT", `${name}: indique os minutos de atraso (1 a ${MAX_MINUTES_LATE}).`));
    return ok({ employeeId: raw.employeeId, status: "ATRASO", minutesLate: m, note });
  }
  if (raw.status === "FALTA_JUSTIFICADA" && (!note || note.length < 3)) return fail(hrError("INVALID_INPUT", `${name}: indique o motivo da falta justificada.`));
  return ok({ employeeId: raw.employeeId, status: raw.status, minutesLate: null, note });
}

/** Os dias de um mês "AAAA-MM" (dia da semana: 0 = domingo). */
export function monthDays(month: string) {
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(first, i);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return { date, day: i + 1, weekday, weekend: weekday === 0 || weekday === 6 };
  });
}

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && isIsoDate(`${s}-01`);

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5)) - 1]} de ${month.slice(0, 4)}`;
export const WEEKDAY_SHORT = ["D", "S", "T", "Q", "Q", "S", "S"];
const WEEKDAY_LONG = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export const dayLabel = (day: string) => {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return `${WEEKDAY_LONG[w]}, ${Number(day.slice(8))} de ${MONTHS[Number(day.slice(5, 7)) - 1]} de ${day.slice(0, 4)}`;
};

/** Totais de uma lista de registos. */
export function attendanceTotals(records: { status: AttendanceStatus; minutesLate: number | null }[]) {
  const n = (s: AttendanceStatus) => records.filter((r) => r.status === s).length;
  return {
    presences: n("PRESENTE") + n("ATRASO"),
    late: n("ATRASO"),
    minutesLate: records.reduce((t, r) => t + (r.minutesLate ?? 0), 0),
    absences: n("FALTA"),
    justified: n("FALTA_JUSTIFICADA"),
    marked: records.length,
  };
}
