import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * Área pedagógica — tudo vive dentro de um ANO LETIVO:
 *   ano letivo (início, fim) → classes (Iniciação, 1.ª … 13.ª) → turmas (A, B…; turno, sala, lotação)
 *
 * Ciclo de vida do ano: PLANNED (a preparar) → ACTIVE (em curso, só um) → CLOSED (só leitura).
 */
export type YearStatus = "PLANNED" | "ACTIVE" | "CLOSED";
export type Shift = "MANHA" | "TARDE" | "NOITE";

export const YEAR_STATUS_LABELS: Record<YearStatus, string> = { PLANNED: "A preparar", ACTIVE: "Em curso", CLOSED: "Encerrado" };
export const SHIFT_LABELS: Record<Shift, string> = { MANHA: "Manhã", TARDE: "Tarde", NOITE: "Noite" };
export const SHIFTS = Object.keys(SHIFT_LABELS) as Shift[];

export type PedagogyErrorCode =
  | "YEAR_NOT_FOUND"
  | "CLASS_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "INVALID_DATES"
  | "YEAR_OVERLAP"
  | "YEAR_NAME_TAKEN"
  | "ACTIVE_YEAR_EXISTS"
  | "YEAR_CLOSED"
  | "INVALID_STATE"
  | "CLASS_EXISTS"
  | "GROUP_EXISTS"
  | "INVALID_INPUT"
  | "FORBIDDEN";

export type PedagogyError = DomainError<PedagogyErrorCode>;
export const pedagogyError = (code: PedagogyErrorCode, message: string, meta?: Record<string, unknown>): PedagogyError =>
  new DomainError(code, message, meta);

// ================================================================ datas

const DAY_MS = 86_400_000;
/** Um ano letivo dura entre 3 e 18 meses. */
export const YEAR_MIN_DAYS = 90;
export const YEAR_MAX_DAYS = 550;

/** "2026-09-01" → Date (meia-noite UTC). null se a data não existir. */
export function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

export const formatDay = (d: Date) => d.toISOString().slice(0, 10);

export function checkDates(startsOn: Date, endsOn: Date): Result<void, PedagogyError> {
  const days = Math.round((endsOn.getTime() - startsOn.getTime()) / DAY_MS);
  if (days <= 0) return fail(pedagogyError("INVALID_DATES", "A data de fim tem de ser depois da data de início."));
  if (days < YEAR_MIN_DAYS) return fail(pedagogyError("INVALID_DATES", "Um ano letivo tem de durar pelo menos 3 meses."));
  if (days > YEAR_MAX_DAYS) return fail(pedagogyError("INVALID_DATES", "Um ano letivo não pode durar mais de 18 meses."));
  return ok(undefined);
}

/** Nome sugerido: "2026/2027" (atravessa dois anos civis) ou "2026". */
export function suggestYearName(startsOn: Date, endsOn: Date) {
  const a = startsOn.getUTCFullYear();
  const b = endsOn.getUTCFullYear();
  return a === b ? String(a) : `${a}/${b}`;
}

export function cleanName(raw: string, max = 40): Result<string, PedagogyError> {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return fail(pedagogyError("INVALID_INPUT", "Indique o nome."));
  if (name.length > max) return fail(pedagogyError("INVALID_INPUT", `O nome tem no máximo ${max} caracteres.`));
  return ok(name);
}

// ================================================================ classes (sistema de ensino angolano)

export const GRADES = Array.from({ length: 14 }, (_, i) => i);

export function gradeLabel(grade: number) {
  return grade === 0 ? "Iniciação" : `${grade}.ª Classe`;
}

export function gradeLevel(grade: number) {
  if (grade === 0) return "Pré-escolar";
  if (grade <= 6) return "Ensino Primário";
  if (grade <= 9) return "I Ciclo do Ensino Secundário";
  return "II Ciclo do Ensino Secundário";
}

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || null;

/**
 * No II Ciclo (10.ª–13.ª) cada classe pertence a um curso — obrigatório, porque
 * o colégio pode ter várias 10.ª (uma por curso). Nas outras não há curso.
 */
export function checkClass(
  grade: number,
  course: string | null,
  description: string | null = null,
): Result<{ grade: number; course: string | null; description: string | null }, PedagogyError> {
  if (!Number.isInteger(grade) || grade < 0 || grade > 13) return fail(pedagogyError("INVALID_INPUT", "Escolha uma classe entre a Iniciação e a 13.ª."));
  const c = clean(course);
  if (c && grade < 10) return fail(pedagogyError("INVALID_INPUT", "Só as classes do II Ciclo (10.ª a 13.ª) têm curso."));
  if (!c && grade >= 10) return fail(pedagogyError("INVALID_INPUT", "Indique o curso: no II Ciclo cada classe pertence a um curso."));
  if (c && c.length > 80) return fail(pedagogyError("INVALID_INPUT", "O nome do curso tem no máximo 80 caracteres."));
  const d = clean(description);
  if (d && d.length > 160) return fail(pedagogyError("INVALID_INPUT", "A descrição tem no máximo 160 caracteres."));
  return ok({ grade, course: c, description: d });
}

// ================================================================ turmas

export function checkGroup(input: { name: string; shift: string; room?: string | null; capacity?: number | null }): Result<
  { name: string; shift: Shift; room: string | null; capacity: number | null },
  PedagogyError
> {
  const name = cleanName(input.name, 20);
  if (!name.ok) return name;
  if (!(SHIFTS as string[]).includes(input.shift)) return fail(pedagogyError("INVALID_INPUT", "Escolha o turno: manhã, tarde ou noite."));
  const room = input.room?.replace(/\s+/g, " ").trim() || null;
  if (room && room.length > 40) return fail(pedagogyError("INVALID_INPUT", "A sala tem no máximo 40 caracteres."));
  const capacity = input.capacity ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 200)) {
    return fail(pedagogyError("INVALID_INPUT", "A lotação tem de ser entre 1 e 200 alunos."));
  }
  return ok({ name: name.value.toUpperCase().length <= 3 ? name.value.toUpperCase() : name.value, shift: input.shift as Shift, room, capacity });
}

/** Próximo nome livre: A, B, C… (depois de Z: A1, B1…). */
export function nextGroupName(taken: string[]) {
  const used = new Set(taken.map((t) => t.toUpperCase()));
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 26; i++) {
      const name = String.fromCharCode(65 + i) + (round ? String(round) : "");
      if (!used.has(name)) return name;
    }
  }
  return "";
}
