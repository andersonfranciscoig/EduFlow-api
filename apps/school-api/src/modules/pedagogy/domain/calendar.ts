import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { formatDay, parseDay, type PedagogyError, pedagogyError } from "./academic";

/**
 * CALENDÁRIO ESCOLAR de um ano letivo:
 *   períodos de avaliação — 3 trimestres (por omissão) ou 2 semestres, com datas, por ordem,
 *   dentro do ano e sem se sobreporem (pode haver dias entre eles: as pausas);
 *   dias sem aulas — feriados, pausas e outros: aí não há aulas a registar nem pendências.
 */
export type PeriodKind = "TRIMESTRE" | "SEMESTRE";
export type ClosureKind = "FERIADO" | "PAUSA" | "OUTRO";

export const PERIOD_KINDS: Record<PeriodKind, { label: string; count: number; unit: string }> = {
  TRIMESTRE: { label: "Trimestres", count: 3, unit: "Trimestre" },
  SEMESTRE: { label: "Semestres", count: 2, unit: "Semestre" },
};
export const CLOSURE_KINDS: Record<ClosureKind, string> = { FERIADO: "Feriado", PAUSA: "Pausa letiva", OUTRO: "Outro" };

export const isPeriodKind = (v: string): v is PeriodKind => v in PERIOD_KINDS;
export const isClosureKind = (v: string): v is ClosureKind => v in CLOSURE_KINDS;

/** "1.º Trimestre", "2.º Semestre"… */
export const periodName = (kind: PeriodKind, position: number) => `${position}.º ${PERIOD_KINDS[kind].unit}`;

const DAY_MS = 86_400_000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** Sugestão: o ano dividido em partes iguais, seguidas (o colégio ajusta as datas). */
export function suggestPeriods(kind: PeriodKind, startsOn: Date, endsOn: Date) {
  const n = PERIOD_KINDS[kind].count;
  const total = Math.round((endsOn.getTime() - startsOn.getTime()) / DAY_MS) + 1;
  const size = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => {
    const s = addDays(startsOn, i * size);
    const e = i === n - 1 ? endsOn : addDays(startsOn, (i + 1) * size - 1);
    return { position: i + 1, name: periodName(kind, i + 1), startsOn: formatDay(s), endsOn: formatDay(e) };
  });
}

/**
 * Valida os períodos de um ano: tantos quantos o tipo pede, cada um dentro do ano,
 * por ordem e sem se sobreporem.
 */
export function checkPeriods(kind: PeriodKind, year: { startsOn: Date; endsOn: Date }, items: { startsOn: string; endsOn: string }[]): Result<{ position: number; startsOn: Date; endsOn: Date }[], PedagogyError> {
  const n = PERIOD_KINDS[kind].count;
  if (items.length !== n) return fail(pedagogyError("PERIODS_INVALID", `Indique as datas dos ${n} ${PERIOD_KINDS[kind].label.toLowerCase()}.`));
  const out: { position: number; startsOn: Date; endsOn: Date }[] = [];
  for (const [i, it] of items.entries()) {
    const name = periodName(kind, i + 1);
    const s = parseDay(it.startsOn);
    const e = parseDay(it.endsOn);
    if (!s || !e) return fail(pedagogyError("PERIODS_INVALID", `${name}: datas inválidas.`, { position: i + 1 }));
    if (e < s) return fail(pedagogyError("PERIODS_INVALID", `${name}: o fim tem de ser depois do início.`, { position: i + 1 }));
    if (s < year.startsOn || e > year.endsOn) return fail(pedagogyError("PERIODS_INVALID", `${name}: tem de ficar dentro do ano letivo.`, { position: i + 1 }));
    const prev = out[i - 1];
    if (prev && s <= prev.endsOn) return fail(pedagogyError("PERIODS_INVALID", `${name}: tem de começar depois do fim do ${periodName(kind, i)}.`, { position: i + 1 }));
    out.push({ position: i + 1, startsOn: s, endsOn: e });
  }
  return ok(out);
}

/** Um intervalo de dias sem aulas: datas válidas, dentro do ano, no máximo 120 dias. */
export function checkClosure(year: { startsOn: Date; endsOn: Date }, input: { startsOn: string; endsOn?: string | null; kind: string; reason: string }): Result<{ startsOn: Date; endsOn: Date; kind: ClosureKind; reason: string }, PedagogyError> {
  const s = parseDay(input.startsOn);
  const e = input.endsOn ? parseDay(input.endsOn) : s;
  if (!s || !e) return fail(pedagogyError("INVALID_DATES", "Datas inválidas."));
  if (e < s) return fail(pedagogyError("INVALID_DATES", "O fim tem de ser no mesmo dia ou depois do início."));
  if (s < year.startsOn || e > year.endsOn) return fail(pedagogyError("INVALID_DATES", "Os dias sem aulas têm de ficar dentro do ano letivo."));
  if ((e.getTime() - s.getTime()) / DAY_MS > 120) return fail(pedagogyError("INVALID_DATES", "No máximo 120 dias seguidos."));
  if (!isClosureKind(input.kind)) return fail(pedagogyError("INVALID_INPUT", "Escolha o tipo: feriado, pausa letiva ou outro."));
  const reason = input.reason.replace(/\s+/g, " ").trim();
  if (reason.length < 2 || reason.length > 120) return fail(pedagogyError("INVALID_INPUT", "Indique o motivo (2 a 120 caracteres)."));
  return ok({ startsOn: s, endsOn: e, kind: input.kind, reason });
}

/** Dias úteis (segunda a sexta) de um intervalo — para mostrar quantos dias de aulas se perdem. */
export function weekdaysBetween(s: Date, e: Date) {
  let n = 0;
  for (let d = s; d <= e; d = addDays(d, 1)) if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) n++;
  return n;
}
