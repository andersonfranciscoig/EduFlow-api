import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type PedagogyError, pedagogyError, type Shift } from "./academic";

/**
 * DISCIPLINAS e HORÁRIOS.
 *   disciplina      catálogo do colégio (nome, sigla, cor)
 *   plano curricular disciplinas de cada classe no ano + tempos por semana
 *   tempos letivos  por turno: início/fim, aula ou intervalo
 *   horário         turma × dia (seg–sex) × tempo → disciplina (+ sala, + professor)
 */

// ================================================================ disciplinas

/** Cores para as disciplinas no horário (tons legíveis com texto escuro por cima). */
export const SUBJECT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#d4a017", "#8a63d2", "#e0517a", "#0f9bb3", "#6b8e23", "#b5651d", "#64748b"] as const;

export interface SubjectInput {
  name: string;
  code: string;
  color: string;
}

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || "";

export function checkSubject(input: { name: string; code: string; color?: string | null }): Result<SubjectInput, PedagogyError> {
  const name = clean(input.name);
  if (name.length < 2) return fail(pedagogyError("INVALID_INPUT", "Indique o nome da disciplina."));
  if (name.length > 60) return fail(pedagogyError("INVALID_INPUT", "O nome da disciplina tem no máximo 60 caracteres."));
  const code = clean(input.code).toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return fail(pedagogyError("INVALID_INPUT", "A sigla tem 2 a 6 letras ou números (ex.: MAT)."));
  const color = (input.color ?? SUBJECT_COLORS[0]).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) return fail(pedagogyError("INVALID_INPUT", "Cor inválida."));
  return ok({ name, code, color });
}

/** Plano curricular: cada disciplina uma vez, 1–20 tempos por semana. */
export function checkCurriculum(items: { subjectId: string; weeklyPeriods: number }[]): Result<{ subjectId: string; weeklyPeriods: number }[], PedagogyError> {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.subjectId)) return fail(pedagogyError("INVALID_INPUT", "Cada disciplina só pode aparecer uma vez no plano."));
    seen.add(it.subjectId);
    if (!Number.isInteger(it.weeklyPeriods) || it.weeklyPeriods < 1 || it.weeklyPeriods > 20) return fail(pedagogyError("INVALID_INPUT", "Os tempos por semana vão de 1 a 20."));
  }
  if (items.length > 30) return fail(pedagogyError("INVALID_INPUT", "Um plano tem no máximo 30 disciplinas."));
  return ok(items);
}

// ================================================================ tempos letivos

export type PeriodKind = "AULA" | "INTERVALO";
export interface PeriodInput {
  startsAt: string;
  endsAt: string;
  kind: PeriodKind;
}

/** Tempos por omissão de cada turno (o colégio ajusta). 45 min de aula; intervalo a meio. */
export const DEFAULT_PERIODS: Record<Shift, PeriodInput[]> = {
  MANHA: [
    { startsAt: "07:00", endsAt: "07:45", kind: "AULA" },
    { startsAt: "07:45", endsAt: "08:30", kind: "AULA" },
    { startsAt: "08:30", endsAt: "09:15", kind: "AULA" },
    { startsAt: "09:15", endsAt: "09:35", kind: "INTERVALO" },
    { startsAt: "09:35", endsAt: "10:20", kind: "AULA" },
    { startsAt: "10:20", endsAt: "11:05", kind: "AULA" },
    { startsAt: "11:05", endsAt: "11:50", kind: "AULA" },
  ],
  TARDE: [
    { startsAt: "13:00", endsAt: "13:45", kind: "AULA" },
    { startsAt: "13:45", endsAt: "14:30", kind: "AULA" },
    { startsAt: "14:30", endsAt: "15:15", kind: "AULA" },
    { startsAt: "15:15", endsAt: "15:35", kind: "INTERVALO" },
    { startsAt: "15:35", endsAt: "16:20", kind: "AULA" },
    { startsAt: "16:20", endsAt: "17:05", kind: "AULA" },
    { startsAt: "17:05", endsAt: "17:50", kind: "AULA" },
  ],
  NOITE: [
    { startsAt: "18:30", endsAt: "19:10", kind: "AULA" },
    { startsAt: "19:10", endsAt: "19:50", kind: "AULA" },
    { startsAt: "19:50", endsAt: "20:05", kind: "INTERVALO" },
    { startsAt: "20:05", endsAt: "20:45", kind: "AULA" },
    { startsAt: "20:45", endsAt: "21:25", kind: "AULA" },
  ],
};

/** "07:05" → minutos desde a meia-noite (null se inválido). */
export function minutes(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const hhmm = (d: Date) => d.toISOString().slice(11, 16);
export const timeOf = (s: string) => new Date(`1970-01-01T${s}:00.000Z`);

/** Tempos de um turno: por ordem, sem sobreposições, cada um com fim depois do início, pelo menos uma aula. */
export function checkPeriods(items: PeriodInput[]): Result<PeriodInput[], PedagogyError> {
  if (!items.length) return fail(pedagogyError("INVALID_INPUT", "Indique pelo menos um tempo."));
  if (items.length > 15) return fail(pedagogyError("INVALID_INPUT", "Um turno tem no máximo 15 tempos."));
  let prevEnd = -1;
  for (const [i, p] of items.entries()) {
    const a = minutes(p.startsAt);
    const b = minutes(p.endsAt);
    if (a === null || b === null) return fail(pedagogyError("INVALID_INPUT", `Tempo ${i + 1}: indique as horas no formato HH:MM.`));
    if (b <= a) return fail(pedagogyError("INVALID_INPUT", `Tempo ${i + 1}: o fim tem de ser depois do início.`));
    if (a < prevEnd) return fail(pedagogyError("INVALID_INPUT", `Tempo ${i + 1}: começa antes de o anterior acabar.`));
    prevEnd = b;
  }
  if (!items.some((p) => p.kind === "AULA")) return fail(pedagogyError("INVALID_INPUT", "O turno precisa de pelo menos um tempo de aula."));
  return ok(items);
}

// ================================================================ horário

export const WEEKDAYS = [
  { value: 1, label: "Segunda-feira", short: "Seg" },
  { value: 2, label: "Terça-feira", short: "Ter" },
  { value: 3, label: "Quarta-feira", short: "Qua" },
  { value: 4, label: "Quinta-feira", short: "Qui" },
  { value: 5, label: "Sexta-feira", short: "Sex" },
] as const;

export const isWeekday = (d: number) => WEEKDAYS.some((w) => w.value === d);
