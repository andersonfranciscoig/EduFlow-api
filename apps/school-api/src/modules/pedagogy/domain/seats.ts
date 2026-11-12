/**
 * VAGAS de uma classe num ano letivo.
 *
 *   lugares      = soma da lotação das turmas (turmas sem lotação não contam)
 *   vagas        = as definidas pela direção, nunca acima dos lugares (sem definição = lugares)
 *   ocupadas     = alunos já colocados numa turma (reserva CONFIRMED)
 *   reservadas   = inscrições em curso, ainda no prazo (reserva HELD)
 *   disponíveis  = vagas − ocupadas − reservadas
 *
 * A inscrição (módulo seguinte) usa estas regras: reserva uma vaga na classe/curso
 * escolhido e, ao confirmar, coloca o aluno numa turma com lugar — nunca acima da lotação.
 */
export type ReservationStatus = "HELD" | "CONFIRMED" | "RELEASED";

/** Prazo de uma reserva (inscrição por concluir), em horas. */
export const HOLD_HOURS_DEFAULT = 72;
export const HOLD_HOURS_MAX = 720;

export interface SeatNumbers {
  /** soma da lotação das turmas */
  capacity: number;
  /** turmas sem lotação definida (não contam para as vagas) */
  groupsWithoutCapacity: number;
  /** definido pela direção (null = usar os lugares) */
  vacanciesSet: number | null;
  /** vagas efetivas */
  vacancies: number;
  held: number;
  confirmed: number;
  /** ocupadas + reservadas */
  taken: number;
  available: number;
}

export function seatNumbers(groupCapacities: (number | null)[], vacanciesSet: number | null, held: number, confirmed: number): SeatNumbers {
  const capacity = groupCapacities.reduce<number>((n, c) => n + (c ?? 0), 0);
  const vacancies = vacanciesSet === null ? capacity : Math.min(vacanciesSet, capacity);
  const taken = held + confirmed;
  return {
    capacity,
    groupsWithoutCapacity: groupCapacities.filter((c) => c === null).length,
    vacanciesSet,
    vacancies,
    held,
    confirmed,
    taken,
    available: Math.max(0, vacancies - taken),
  };
}

/** Vagas efetivas se a lotação/definição mudar (para validar antes de gravar). */
export const effectiveVacancies = (capacity: number, vacanciesSet: number | null) => (vacanciesSet === null ? capacity : Math.min(vacanciesSet, capacity));

/**
 * Turma onde colocar um aluno: a pedida (se tiver lugar) ou a que tem mais
 * lugares livres (empate → a primeira por nome). Turmas sem lotação não recebem.
 */
export function pickGroup(
  groups: { id: string; name: string; capacity: number | null; confirmed: number }[],
  wanted: string | null,
): { ok: true; id: string } | { ok: false; reason: "invalid_group" | "group_full" } {
  const free = (g: (typeof groups)[number]) => (g.capacity ?? 0) - g.confirmed;
  if (wanted) {
    const g = groups.find((x) => x.id === wanted);
    if (!g) return { ok: false, reason: "invalid_group" };
    return free(g) > 0 ? { ok: true, id: g.id } : { ok: false, reason: "group_full" };
  }
  const best = [...groups]
    .filter((g) => free(g) > 0)
    .sort((a, b) => free(b) - free(a) || a.name.localeCompare(b.name, "pt", { numeric: true }))[0];
  return best ? { ok: true, id: best.id } : { ok: false, reason: "group_full" };
}

/** Referência de quem ocupa a vaga (ex.: n.º da inscrição). */
export function cleanReference(raw: string): string | null {
  const ref = raw.replace(/\s+/g, " ").trim();
  return ref.length >= 1 && ref.length <= 60 ? ref : null;
}
