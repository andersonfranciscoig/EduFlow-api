import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * MODELO DE AVALIAÇÃO — as regras com que um colégio calcula as classificações. Nada é universal:
 * a escala, os componentes e pesos, os arredondamentos, as faltas, a média do ano, o exame e a
 * recuperação são do colégio.
 *
 * Três coisas diferentes, que nunca se confundem:
 *   cotação máxima  quanto vale a avaliação (ex.: um teste de 0 a 100)
 *   nota            o que o aluno teve nessa cotação (ex.: 70 em 100 = 14 em 20)
 *   peso            a parte que o componente tem na média do período (ex.: 40 %)
 *
 * Um rascunho pode estar incompleto (`problemsOf` diz o que falta); só se publica sem problemas.
 */
export type GradingErrorCode = "INVALID_INPUT" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE" | "NAME_TAKEN" | "CHANGED" | "IN_USE" | "INCOMPLETE" | "NEEDS_CONFIRMATION" | "YEAR_CLOSED";
export type GradingError = DomainError<GradingErrorCode>;
export const gradingError = (code: GradingErrorCode, message: string, meta?: Record<string, unknown>): GradingError => new DomainError(code, message, meta);

export const MODEL_KINDS = {
  NUMERIC: { label: "Quantitativa", hint: "Só números, na escala do colégio." },
  MIXED: { label: "Quantitativa e qualitativa", hint: "Números, com a menção e a apreciação do professor." },
  QUALITATIVE: { label: "Só qualitativa", hint: "Menções e apreciação, sem números (pré-escolar e primeiras classes)." },
} as const;
export const ROUNDINGS = {
  HALF_UP: { label: "Arredondar", hint: "A metade sobe: 9,5 → 10." },
  DOWN: { label: "Truncar", hint: "Corta o que sobra: 9,9 → 9." },
} as const;
export const WEIGHTINGS = {
  PERCENT: { label: "Por percentagem", hint: "Cada componente tem o seu peso; juntos dão 100%." },
  EQUAL: { label: "Todos iguais", hint: "Média simples dos componentes." },
} as const;
/** De onde vêm as notas de um componente. */
export const SOURCES = {
  CONTINUOUS: { label: "Avaliação contínua", hint: "Várias avaliações ao longo do período, criadas pelo professor." },
  TEACHER_TEST: { label: "Prova do professor", hint: "A prova (ou provas) feita pelo professor." },
  TERM_TEST: { label: "Prova trimestral ou semestral", hint: "A prova do fim do período, do calendário de provas." },
  OTHER: { label: "Outra", hint: "Projeto, estágio, portefólio…" },
} as const;
/** Como se juntam as avaliações de um componente. */
export const AGGREGATIONS = {
  MEAN: { label: "Média simples", hint: "Todas as avaliações valem o mesmo." },
  WEIGHTED: { label: "Média ponderada", hint: "O professor dá um peso a cada avaliação." },
  BY_TYPE: { label: "Por elemento", hint: "Cada elemento (participação, testes…) tem o seu peso." },
  BEST: { label: "Melhor nota", hint: "Conta só a melhor avaliação." },
} as const;
export const UNJUSTIFIED = { ZERO: "Conta zero", EXCLUDE: "Não entra na média" } as const;
export const JUSTIFIED = { PENDING: "Fica pendente até ser feita", EXCLUDE: "Não entra na média" } as const;
export const RECOVERY_RESULTS = { REPLACE: "Substitui a nota", BEST: "Fica a melhor das duas", MEAN: "Média das duas" } as const;
export const DESCRIPTIVE = { NONE: "Sem apreciação escrita", OPTIONAL: "Opcional", REQUIRED: "Obrigatória" } as const;

type Keys<T> = Extract<keyof T, string>;
export type ModelKind = Keys<typeof MODEL_KINDS>;
export type Rounding = Keys<typeof ROUNDINGS>;

export interface Level {
  key: string;
  label: string;
  /** a menção vale a partir desta nota (null nos modelos só qualitativos) */
  from: number | null;
  /** nos modelos só qualitativos: conta como positiva? */
  positive: boolean;
}
export interface Component {
  /** estável entre versões: as avaliações lançadas continuam a pertencer-lhe */
  key: string;
  name: string;
  source: Keys<typeof SOURCES>;
  /** percentagem na média do período (null = por preencher, ou pesos iguais) */
  weight: number | null;
  aggregation: Keys<typeof AGGREGATIONS>;
  /** quantas avaliações por período (null = sem limite) */
  minItems: number;
  maxItems: number | null;
  /** aggregation = BY_TYPE: o peso de cada elemento de avaliação */
  parts: { typeId: string; weight: number | null }[];
}
export interface Definition {
  kind: ModelKind;
  scale: { min: number; max: number; pass: number };
  descriptive: Keys<typeof DESCRIPTIVE>;
  levels: Level[];
  weighting: Keys<typeof WEIGHTINGS>;
  components: Component[];
  /** casas decimais das notas lançadas, da média do período e da nota final */
  decimals: { mark: number; period: number; final: number };
  rounding: Rounding;
  absences: { unjustified: Keys<typeof UNJUSTIFIED>; justified: Keys<typeof JUSTIFIED> };
  /** peso de cada período na nota do ano (null = iguais) */
  periodWeights: (number | null)[] | null;
  /** classes de exame: nota final = frequência × peso + exame × peso */
  exam: {
    enabled: boolean;
    frequencyWeight: number | null;
    examWeight: number | null;
    /** nota de frequência mínima para ir a exame (null = todos vão) */
    minFrequency: number | null;
    /** dispensa de exame a partir desta nota de frequência (null = ninguém) */
    waiveFrom: number | null;
    parts: { key: string; name: string; weight: number | null }[];
  };
  recovery: { enabled: boolean; minMark: number | null; maxSubjects: number | null; result: Keys<typeof RECOVERY_RESULTS> };
}

export const MAX_COMPONENTS = 8;
export const MAX_LEVELS = 8;
export const MAX_MODELS = 40;
export const MAX_TYPES = 40;
export const MAX_REASON = 300;

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const bad = (m: string) => fail(gradingError("INVALID_INPUT", m));
/** Comparar percentagens em centésimas: 33,33 + 33,33 + 33,34 = 100 certo. */
const cents = (n: number) => Math.round(n * 100);
const decimals = (n: number, d: number) => Math.abs(n * 10 ** d - Math.round(n * 10 ** d)) < 1e-9;
export const sumsTo100 = (weights: (number | null)[]) => weights.every((w) => w !== null) && weights.reduce<number>((s, w) => s + cents(w!), 0) === 10_000;
const nf = (n: number) => String(n).replace(".", ",");

export interface Problem {
  /** o passo do assistente onde se resolve */
  step: "escala" | "componentes" | "calculo" | "exame" | "recuperacao";
  message: string;
}

/**
 * Valida a FORMA de um modelo (limites, chaves, números) e devolve-o limpo. O que falta para o
 * poder publicar (pesos por preencher, somas) vem de `problemsOf`: um rascunho pode gravar-se a meio.
 */
export function checkDefinition(d: Definition, typeIds: Set<string>): Result<Definition, GradingError> {
  const numeric = d.kind !== "QUALITATIVE";
  const { min, max, pass } = d.scale;
  if (numeric) {
    if (![min, max, pass].every((n) => Number.isFinite(n) && decimals(n, 2))) return bad("A escala só leva números com até duas casas decimais.");
    if (min < 0 || min > 10) return bad("A escala começa entre 0 e 10.");
    if (max <= min || max > 1000) return bad("O máximo da escala tem de ser maior do que o mínimo (até 1000).");
    if (pass <= min || pass > max) return bad("A nota mínima de aprovação tem de ficar dentro da escala.");
  }
  for (const n of [d.decimals.mark, d.decimals.period, d.decimals.final]) if (!Number.isInteger(n) || n < 0 || n > 2) return bad("As casas decimais vão de 0 a 2.");

  if (d.levels.length > MAX_LEVELS) return bad(`No máximo ${MAX_LEVELS} menções.`);
  const levels = d.levels.map((l) => ({ key: l.key, label: clean(l.label), from: numeric ? l.from : null, positive: l.positive }));
  if (new Set(levels.map((l) => l.key)).size !== levels.length) return bad("Há menções repetidas.");
  for (const l of levels) {
    if (l.label.length < 2 || l.label.length > 30) return bad("Cada menção tem 2 a 30 caracteres.");
    if (l.from !== null && (!Number.isFinite(l.from) || !decimals(l.from, 2) || l.from < min || l.from > max)) return bad(`A menção “${l.label}” começa fora da escala.`);
  }
  if (new Set(levels.map((l) => l.label.toLowerCase())).size !== levels.length) return bad("Há menções com o mesmo nome.");
  if (numeric) levels.sort((a, b) => (a.from ?? -1) - (b.from ?? -1));

  if (d.components.length > MAX_COMPONENTS) return bad(`No máximo ${MAX_COMPONENTS} componentes.`);
  const weight = (w: number | null) => w === null || (Number.isFinite(w) && w >= 0 && w <= 100 && decimals(w, 2));
  const components: Component[] = [];
  for (const c of d.components) {
    const name = clean(c.name);
    if (name.length < 2 || name.length > 60) return bad("Cada componente tem um nome com 2 a 60 caracteres.");
    if (!weight(c.weight)) return bad(`O peso de “${name}” vai de 0 a 100, com até duas casas decimais.`);
    if (!Number.isInteger(c.minItems) || c.minItems < 0 || c.minItems > 30) return bad(`Em “${name}”, o mínimo de avaliações vai de 0 a 30.`);
    if (c.maxItems !== null && (!Number.isInteger(c.maxItems) || c.maxItems < 1 || c.maxItems > 60)) return bad(`Em “${name}”, o máximo de avaliações vai de 1 a 60.`);
    if (c.maxItems !== null && c.maxItems < c.minItems) return bad(`Em “${name}”, o máximo de avaliações é menor do que o mínimo.`);
    const parts = c.aggregation === "BY_TYPE" ? c.parts : [];
    if (new Set(parts.map((p) => p.typeId)).size !== parts.length) return bad(`Em “${name}” há elementos repetidos.`);
    if (parts.some((p) => !typeIds.has(p.typeId))) return bad(`Em “${name}” há um elemento de avaliação que já não existe.`);
    if (parts.some((p) => !weight(p.weight))) return bad(`Em “${name}”, os pesos dos elementos vão de 0 a 100.`);
    components.push({ key: c.key, name, source: c.source, weight: numeric && d.weighting === "PERCENT" ? c.weight : null, aggregation: numeric ? c.aggregation : "MEAN", minItems: c.minItems, maxItems: c.maxItems, parts: numeric ? parts.map((p) => ({ typeId: p.typeId, weight: p.weight })) : [] });
  }
  if (new Set(components.map((c) => c.key)).size !== components.length) return bad("Há componentes repetidos.");
  if (new Set(components.map((c) => c.name.toLowerCase())).size !== components.length) return bad("Há componentes com o mesmo nome.");

  let periodWeights = numeric ? d.periodWeights : null;
  if (periodWeights) {
    if (periodWeights.length < 2 || periodWeights.length > 3) return bad("A nota do ano junta 2 semestres ou 3 trimestres.");
    if (!periodWeights.every(weight)) return bad("Os pesos dos períodos vão de 0 a 100.");
    periodWeights = [...periodWeights];
  }

  const e = d.exam;
  const inScale = (n: number | null) => n === null || (Number.isFinite(n) && decimals(n, 2) && n >= min && n <= max);
  const examOn = numeric && e.enabled;
  if (examOn) {
    if (![e.frequencyWeight, e.examWeight].every(weight)) return bad("Os pesos da frequência e do exame vão de 0 a 100.");
    if (!inScale(e.minFrequency)) return bad("A nota mínima para ir a exame está fora da escala.");
    if (!inScale(e.waiveFrom)) return bad("A nota de dispensa do exame está fora da escala.");
    if (e.minFrequency !== null && e.waiveFrom !== null && e.waiveFrom <= e.minFrequency) return bad("A dispensa do exame tem de ser acima da nota mínima para ir a exame.");
    if (e.parts.length > 4) return bad("O exame tem no máximo 4 provas.");
    for (const p of e.parts) {
      if (clean(p.name).length < 2 || clean(p.name).length > 40) return bad("Cada prova do exame tem um nome com 2 a 40 caracteres.");
      if (!weight(p.weight)) return bad("Os pesos das provas do exame vão de 0 a 100.");
    }
    if (new Set(e.parts.map((p) => p.key)).size !== e.parts.length || new Set(e.parts.map((p) => clean(p.name).toLowerCase())).size !== e.parts.length) return bad("Há provas do exame repetidas.");
  }
  const r = d.recovery;
  const recoveryOn = numeric && r.enabled;
  if (recoveryOn) {
    if (!inScale(r.minMark)) return bad("A nota mínima para ir à recuperação está fora da escala.");
    if (r.maxSubjects !== null && (!Number.isInteger(r.maxSubjects) || r.maxSubjects < 1 || r.maxSubjects > 20)) return bad("O número de disciplinas em recuperação vai de 1 a 20.");
  }
  return ok({
    kind: d.kind,
    scale: { min, max, pass },
    descriptive: d.kind === "QUALITATIVE" && d.descriptive === "NONE" ? "OPTIONAL" : d.descriptive,
    levels,
    weighting: d.weighting,
    components,
    decimals: { mark: d.decimals.mark, period: d.decimals.period, final: d.decimals.final },
    rounding: d.rounding,
    absences: { unjustified: d.absences.unjustified, justified: d.absences.justified },
    periodWeights,
    exam: examOn
      ? { enabled: true, frequencyWeight: e.frequencyWeight, examWeight: e.examWeight, minFrequency: e.minFrequency, waiveFrom: e.waiveFrom, parts: e.parts.map((p) => ({ key: p.key, name: clean(p.name), weight: p.weight })) }
      : { enabled: false, frequencyWeight: null, examWeight: null, minFrequency: null, waiveFrom: null, parts: [] },
    recovery: recoveryOn ? { enabled: true, minMark: r.minMark, maxSubjects: r.maxSubjects, result: r.result } : { enabled: false, minMark: null, maxSubjects: null, result: "REPLACE" },
  });
}

/** O que falta (ou não bate certo) para publicar. Vazio = pronto. */
export function problemsOf(d: Definition): Problem[] {
  const out: Problem[] = [];
  const add = (step: Problem["step"], message: string) => out.push({ step, message });
  const numeric = d.kind !== "QUALITATIVE";
  const total = (list: (number | null)[]) => nf(list.reduce<number>((s, w) => s + cents(w ?? 0), 0) / 100);

  if (d.kind !== "NUMERIC" && d.levels.length < 2) add("escala", "Indique pelo menos duas menções (ex.: Bom, Suficiente, Insuficiente).");
  if (numeric && d.levels.length) {
    if (d.levels.some((l) => l.from === null)) add("escala", "Indique a partir de que nota começa cada menção.");
    else {
      if (d.levels[0].from !== d.scale.min) add("escala", `A primeira menção tem de começar no mínimo da escala (${nf(d.scale.min)}).`);
      if (new Set(d.levels.map((l) => l.from)).size !== d.levels.length) add("escala", "Duas menções começam na mesma nota.");
    }
  }
  if (!numeric && d.levels.length >= 2 && (!d.levels.some((l) => l.positive) || d.levels.every((l) => l.positive))) add("escala", "Diga que menções são positivas (pelo menos uma sim e uma não).");

  if (numeric) {
    if (!d.components.length) add("componentes", "Junte pelo menos um componente.");
    else if (d.weighting === "PERCENT") {
      if (d.components.some((c) => c.weight === null)) add("componentes", "Há componentes sem peso.");
      else if (!sumsTo100(d.components.map((c) => c.weight))) add("componentes", `Os pesos somam ${total(d.components.map((c) => c.weight))}%: têm de somar 100%.`);
      if (d.components.some((c) => c.weight === 0)) add("componentes", "Um componente com peso 0% não conta para a média: retire-o ou dê-lhe peso.");
    }
    for (const c of d.components) {
      if (c.aggregation !== "BY_TYPE") continue;
      if (c.parts.length < 2) add("componentes", `Em “${c.name}”, escolha pelo menos dois elementos.`);
      else if (c.parts.some((p) => p.weight === null || p.weight === 0)) add("componentes", `Em “${c.name}”, há elementos sem peso.`);
      else if (!sumsTo100(c.parts.map((p) => p.weight))) add("componentes", `Em “${c.name}”, os elementos somam ${total(c.parts.map((p) => p.weight))}%: têm de somar 100%.`);
    }
    if (d.periodWeights) {
      if (d.periodWeights.some((w) => w === null)) add("calculo", "Há períodos sem peso na nota do ano.");
      else if (!sumsTo100(d.periodWeights)) add("calculo", `Os pesos dos períodos somam ${total(d.periodWeights)}%: têm de somar 100%.`);
    }
    if (d.exam.enabled) {
      if (d.exam.frequencyWeight === null || d.exam.examWeight === null) add("exame", "Indique o peso da frequência e o do exame (as normas oficiais do seu nível).");
      else if (!sumsTo100([d.exam.frequencyWeight, d.exam.examWeight])) add("exame", `A frequência e o exame somam ${total([d.exam.frequencyWeight, d.exam.examWeight])}%: têm de somar 100%.`);
      else if (d.exam.examWeight === 0) add("exame", "Um exame com peso 0% não conta: dê-lhe peso ou desligue o exame.");
      if (d.exam.parts.length) {
        if (d.exam.parts.length < 2) add("exame", "Com uma só prova não é preciso dividir o exame em provas.");
        if (d.exam.parts.some((p) => !p.weight)) add("exame", "Há provas do exame sem peso.");
        else if (!sumsTo100(d.exam.parts.map((p) => p.weight))) add("exame", `As provas do exame somam ${total(d.exam.parts.map((p) => p.weight))}%: têm de somar 100%.`);
      }
    }
    if (d.recovery.enabled && d.recovery.minMark !== null && d.recovery.minMark >= d.scale.pass) add("recuperacao", `Só vai à recuperação quem não chegou a ${nf(d.scale.pass)}: baixe a nota mínima.`);
  }
  return out;
}

/** O modelo numa linha: "0–20 · Contínua 30% · Professor 30% · Trimestral 40%". */
export function summaryOf(d: Definition): string {
  if (d.kind === "QUALITATIVE") return d.levels.map((l) => l.label).join(" · ") || "Menções por definir";
  const n = d.components.length;
  const comps = d.components.map((c) => `${c.name}${d.weighting === "EQUAL" ? "" : c.weight === null ? " (sem peso)" : ` ${nf(c.weight)}%`}`);
  return [`${nf(d.scale.min)}–${nf(d.scale.max)}`, ...(d.weighting === "EQUAL" && n > 1 ? [`Média simples: ${comps.join(", ")}`] : comps), ...(d.exam.enabled ? ["com exame"] : [])].join(" · ");
}

/** Iguais? O jsonb não guarda a ordem das chaves: compara-se com as chaves ordenadas. */
export const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)]));
  return v;
}

/** O que mudou entre duas versões, em palavras, para o histórico. */
export function changesBetween(a: Definition, b: Definition): string[] {
  const out: string[] = [];
  const pct = (w: number | null) => (w === null ? "—" : `${nf(w)}%`);
  if (a.kind !== b.kind) out.push(`Tipo: ${MODEL_KINDS[a.kind].label} → ${MODEL_KINDS[b.kind].label}`);
  if (a.scale.min !== b.scale.min || a.scale.max !== b.scale.max) out.push(`Escala: ${nf(a.scale.min)}–${nf(a.scale.max)} → ${nf(b.scale.min)}–${nf(b.scale.max)}`);
  if (a.scale.pass !== b.scale.pass) out.push(`Nota mínima: ${nf(a.scale.pass)} → ${nf(b.scale.pass)}`);
  if (a.weighting !== b.weighting) out.push(`Pesos: ${WEIGHTINGS[a.weighting].label} → ${WEIGHTINGS[b.weighting].label}`);
  for (const c of b.components) {
    const old = a.components.find((x) => x.key === c.key);
    if (!old) out.push(`Componente novo: ${c.name}${c.weight === null ? "" : ` (${pct(c.weight)})`}`);
    else {
      if (old.name !== c.name) out.push(`${old.name} passou a chamar-se ${c.name}`);
      if (old.weight !== c.weight) out.push(`${c.name}: ${pct(old.weight)} → ${pct(c.weight)}`);
      if (old.aggregation !== c.aggregation) out.push(`${c.name}: ${AGGREGATIONS[old.aggregation].label} → ${AGGREGATIONS[c.aggregation].label}`);
      else if (!same(old.parts, c.parts)) out.push(`${c.name}: elementos alterados`);
      if (old.minItems !== c.minItems || old.maxItems !== c.maxItems) out.push(`${c.name}: quantidade de avaliações alterada`);
    }
  }
  for (const c of a.components) if (!b.components.some((x) => x.key === c.key)) out.push(`Componente retirado: ${c.name}`);
  if (!same(a.levels, b.levels)) out.push("Menções alteradas");
  if (!same(a.decimals, b.decimals) || a.rounding !== b.rounding) out.push("Casas decimais ou arredondamento alterados");
  if (!same(a.absences, b.absences)) out.push("Tratamento das faltas alterado");
  if (!same(a.periodWeights, b.periodWeights)) out.push("Peso dos períodos no ano alterado");
  if (!same(a.exam, b.exam)) out.push("Exame alterado");
  if (!same(a.recovery, b.recovery)) out.push("Recuperação alterada");
  if (a.descriptive !== b.descriptive) out.push(`Apreciação escrita: ${DESCRIPTIVE[a.descriptive]} → ${DESCRIPTIVE[b.descriptive]}`);
  return out;
}

// ---------------------------------------------------------------- modelos sugeridos

const LEVELS_20: Level[] = [
  { key: "mau", label: "Mau", from: 0, positive: false },
  { key: "ins", label: "Insuficiente", from: 6, positive: false },
  { key: "suf", label: "Suficiente", from: 10, positive: true },
  { key: "bom", label: "Bom", from: 14, positive: true },
  { key: "exc", label: "Excelente", from: 17, positive: true },
];
const LEVELS_10: Level[] = [
  { key: "ins", label: "Insuficiente", from: 1, positive: false },
  { key: "suf", label: "Suficiente", from: 5, positive: true },
  { key: "bom", label: "Bom", from: 7, positive: true },
  { key: "exc", label: "Excelente", from: 9, positive: true },
];
const comp = (key: string, name: string, source: Component["source"], weight: number | null, minItems = 1, maxItems: number | null = 1): Component => ({ key, name, source, weight, aggregation: "MEAN", minItems, maxItems, parts: [] });
const NO_EXAM: Definition["exam"] = { enabled: false, frequencyWeight: null, examWeight: null, minFrequency: null, waiveFrom: null, parts: [] };
const NO_RECOVERY: Definition["recovery"] = { enabled: false, minMark: null, maxSubjects: null, result: "REPLACE" };
export const EMPTY_DEFINITION: Definition = {
  kind: "NUMERIC",
  scale: { min: 0, max: 20, pass: 10 },
  descriptive: "NONE",
  levels: [],
  weighting: "PERCENT",
  components: [],
  decimals: { mark: 1, period: 0, final: 0 },
  rounding: "HALF_UP",
  absences: { unjustified: "ZERO", justified: "PENDING" },
  periodWeights: null,
  exam: NO_EXAM,
  recovery: NO_RECOVERY,
};
const HALF: Component[] = [comp("cont", "Avaliação contínua", "CONTINUOUS", 50, 2, null), comp("trim", "Prova trimestral", "TERM_TEST", 50)];

/** Pontos de partida, para o colégio rever: nenhum se aplica sozinho. */
export const PRESETS: { key: string; name: string; hint: string; definition: Definition }[] = [
  {
    key: "qualitativo",
    name: "Qualitativo",
    hint: "Pré-escolar e primeiras classes do primário: menções e apreciação, sem números.",
    definition: { ...EMPTY_DEFINITION, kind: "QUALITATIVE", descriptive: "REQUIRED", levels: LEVELS_10.map((l) => ({ ...l, from: null })) },
  },
  {
    key: "primario",
    name: "Primário · 1 a 10",
    hint: "Últimas classes do primário: 1 a 10 com menção, aprova com 5; contínua e prova em partes iguais.",
    definition: { ...EMPTY_DEFINITION, kind: "MIXED", scale: { min: 1, max: 10, pass: 5 }, descriptive: "OPTIONAL", levels: LEVELS_10, weighting: "EQUAL", components: HALF.map((c) => ({ ...c, weight: null })) },
  },
  {
    key: "secundario-50",
    name: "Secundário · contínua e trimestral",
    hint: "0 a 20, aprova com 10; média simples da avaliação contínua e da prova trimestral.",
    definition: { ...EMPTY_DEFINITION, levels: LEVELS_20, weighting: "EQUAL", components: HALF.map((c) => ({ ...c, weight: null })) },
  },
  {
    key: "secundario-30",
    name: "Secundário · contínua 30, professor 30, trimestral 40",
    hint: "0 a 20, aprova com 10; médias do período com uma casa decimal.",
    definition: {
      ...EMPTY_DEFINITION,
      levels: LEVELS_20,
      decimals: { mark: 1, period: 1, final: 0 },
      components: [comp("cont", "Avaliação contínua", "CONTINUOUS", 30, 2, null), comp("prof", "Prova do professor", "TEACHER_TEST", 30), comp("trim", "Prova trimestral", "TERM_TEST", 40)],
    },
  },
  {
    key: "exame",
    name: "Classe de exame · 0 a 20",
    hint: "Frequência e exame no fim do ano. Os pesos ficam por preencher: confirme-os na norma oficial.",
    definition: {
      ...EMPTY_DEFINITION,
      levels: LEVELS_20,
      weighting: "EQUAL",
      components: HALF.map((c) => ({ ...c, weight: null })),
      exam: { ...NO_EXAM, enabled: true },
      recovery: { enabled: true, minMark: 6, maxSubjects: 3, result: "REPLACE" },
    },
  },
  { key: "vazio", name: "Começar do zero", hint: "0 a 20, sem componentes: define tudo.", definition: EMPTY_DEFINITION },
];

export const TYPE_SUGGESTIONS = ["Participação", "Trabalho individual", "Trabalho em grupo", "Trabalho de casa", "Teste escrito", "Teste oral", "Ficha de exercícios", "Atividade prática", "Projeto", "Caderno diário"];

export function checkName(raw: string, what = "modelo"): Result<string, GradingError> {
  const name = clean(raw);
  return name.length < 3 || name.length > 80 ? bad(`O nome do ${what} tem 3 a 80 caracteres.`) : ok(name);
}
export function checkTypeName(raw: string): Result<string, GradingError> {
  const name = clean(raw);
  return name.length < 2 || name.length > 60 ? bad("O nome do elemento tem 2 a 60 caracteres.") : ok(name);
}
export const cleanText = clean;
