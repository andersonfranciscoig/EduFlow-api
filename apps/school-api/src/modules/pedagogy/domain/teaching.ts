/**
 * PROFESSORES — quem dá cada disciplina em cada turma, coordenadores e choques de horário.
 *   professor   um funcionário aprovado ou ativo (o RH trata do cadastro)
 *   choque      o mesmo professor com duas aulas que se sobrepõem no mesmo dia
 *               (compara as HORAS dos tempos: turnos diferentes podem sobrepor-se)
 */
export const TEACHER_STATUSES = ["APPROVED", "ACTIVE"] as const;

export interface TimedLesson {
  id: string;
  weekday: number;
  /** "HH:MM" */
  startsAt: string;
  endsAt: string;
  groupId: string;
}

/** Dois tempos sobrepõem-se? (o fim de um pode ser o início do outro) */
export const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** Pares de aulas do mesmo professor que chocam (em turmas diferentes). */
export function clashPairs<T extends TimedLesson>(lessons: T[]): [T, T][] {
  const out: [T, T][] = [];
  const sorted = [...lessons].sort((a, b) => a.weekday - b.weekday || a.startsAt.localeCompare(b.startsAt));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].weekday === sorted[i].weekday; j++) {
      if (sorted[i].groupId !== sorted[j].groupId && overlaps(sorted[i], sorted[j])) out.push([sorted[i], sorted[j]]);
    }
  }
  return out;
}

export const WEEKDAY_LABELS: Record<number, string> = { 1: "Segunda", 2: "Terça", 3: "Quarta", 4: "Quinta", 5: "Sexta" };
