/**
 * TRANSIÇÃO DE ANO — o resultado de um aluno a partir das notas finais publicadas de cada disciplina
 * e das regras do colégio para o seu ensino. Nada é universal: sem regras, fica "por decidir".
 *
 *   PASSED     transita
 *   RETAINED   não transita
 *   RECOVERY   ainda pode ir à recuperação (as negativas que o impedem de transitar têm recuperação)
 *   UNDECIDED  falta publicar a nota final de alguma disciplina, ou o colégio não definiu as regras
 *
 * A direção pode deliberar outro resultado (com o motivo): isso fica à parte e ganha a este.
 */
export type Outcome = "PASSED" | "RETAINED" | "RECOVERY" | "UNDECIDED";
export const OUTCOME_LABELS: Record<Outcome, string> = { PASSED: "Transita", RETAINED: "Não transita", RECOVERY: "Em recuperação", UNDECIDED: "Por decidir" };

export interface ProgressionRule {
  /** quantas disciplinas negativas ainda transitam (null = regra por definir) */
  maxNegatives: number | null;
  /** disciplinas nucleares e quantas delas podem ser negativas (null = sem limite próprio) */
  coreSubjectIds: string[];
  maxCoreNegatives: number | null;
}
export interface SubjectFinal {
  subjectId: string;
  name: string;
  /** a nota final foi publicada */
  published: boolean;
  passed: boolean | null;
  /** negativa, mas ainda pode ir à prova de recuperação (regras do modelo da disciplina) */
  recoveryOpen: boolean;
  /** o limite de disciplinas em recuperação por aluno, do modelo da disciplina (null = sem limite) */
  recoveryMax: number | null;
}
export interface Progression {
  outcome: Outcome;
  negatives: string[];
  coreNegatives: string[];
  recovery: string[];
  reasons: string[];
}

const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`);

export function progressionOf(rule: ProgressionRule | null, subjects: SubjectFinal[]): Progression {
  const missing = subjects.filter((s) => !s.published);
  const negatives = subjects.filter((s) => s.published && s.passed === false);
  const core = new Set(rule?.coreSubjectIds ?? []);
  const coreNeg = negatives.filter((s) => core.has(s.subjectId));
  const base = { negatives: negatives.map((s) => s.name), coreNegatives: coreNeg.map((s) => s.name) };
  if (!subjects.length) return { ...base, outcome: "UNDECIDED", recovery: [], reasons: ["Ainda sem disciplinas com nota final."] };
  if (missing.length) return { ...base, outcome: "UNDECIDED", recovery: [], reasons: [`Falta publicar a nota final de ${list(missing.map((s) => s.name))}.`] };
  if (!rule || rule.maxNegatives === null) return { ...base, outcome: "UNDECIDED", recovery: [], reasons: ["O colégio ainda não definiu as regras de transição deste ensino."] };

  const tooMany = negatives.length > rule.maxNegatives;
  const tooManyCore = rule.maxCoreNegatives !== null && coreNeg.length > rule.maxCoreNegatives;
  if (!tooMany && !tooManyCore)
    return { ...base, outcome: "PASSED", recovery: [], reasons: negatives.length ? [`${negatives.length} ${negatives.length === 1 ? "negativa" : "negativas"} (${list(base.negatives)}): o colégio admite até ${rule.maxNegatives}.`] : [] };

  // a recuperação só conta se o aluno não passar do limite de disciplinas em recuperação de nenhum modelo
  const open = negatives.filter((s) => s.recoveryOpen && (s.recoveryMax === null || negatives.length <= s.recoveryMax));
  const reasons: string[] = [];
  if (tooMany) reasons.push(`${negatives.length} negativas (${list(base.negatives)}): o colégio admite até ${rule.maxNegatives}.`);
  if (tooManyCore) reasons.push(`${coreNeg.length} ${coreNeg.length === 1 ? "negativa" : "negativas"} em disciplinas nucleares (${list(base.coreNegatives)}): admite até ${rule.maxCoreNegatives}.`);
  if (open.length) {
    reasons.push(`Pode ir à recuperação a ${list(open.map((s) => s.name))}.`);
    return { ...base, outcome: "RECOVERY", recovery: open.map((s) => s.name), reasons };
  }
  return { ...base, outcome: "RETAINED", recovery: [], reasons };
}
