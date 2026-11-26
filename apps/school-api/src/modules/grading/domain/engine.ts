import type { Component, Definition, Level } from "./model";

/**
 * MOTOR DE CÁLCULO — a única fonte oficial das classificações. Funções puras: recebem o modelo
 * (uma versão publicada, ou o rascunho no simulador) e as notas, e devolvem o resultado com a
 * conta escrita passo a passo, para o professor, a direção e a família perceberem de onde vem.
 *
 * Regras fixas (o resto vem do modelo do colégio):
 *  - as contas intermédias fazem-se com todas as casas; só se arredonda a nota lançada, a média
 *    do período e a nota final, com as casas e o arredondamento do modelo;
 *  - uma nota numa cotação própria converte-se para a escala: 70 em 100 numa escala até 20 = 14;
 *  - sem as notas mínimas de um componente, a média fica POR FAZER (nunca se inventa um valor);
 *  - um componente sem avaliações porque o aluno foi dispensado de todas sai da conta e o seu
 *    peso reparte-se, na proporção, pelos restantes (fica escrito no resultado).
 */

export type MarkState = "GRADED" | "ABSENT" | "ABSENT_JUSTIFIED" | "EXEMPT";
export const MARK_STATES: Record<MarkState, string> = { GRADED: "Com nota", ABSENT: "Faltou (injustificada)", ABSENT_JUSTIFIED: "Faltou (justificada)", EXEMPT: "Dispensado" };

export interface MarkInput {
  component: string;
  label?: string | null;
  /** elemento de avaliação (componentes "por elemento") */
  typeId?: string | null;
  /** peso desta avaliação (componentes de média ponderada; vazio = 1) */
  weight?: number | null;
  /** o que o aluno teve; com `outOf`, na cotação da avaliação; sem, já na escala */
  score: number | null;
  outOf?: number | null;
  state: MarkState;
}
export interface PeriodInput {
  marks: MarkInput[];
  /** modelos qualitativos: a menção dada pelo professor */
  level?: string | null;
  comment?: string | null;
}

/** DONE = calculada · PENDING = à espera de uma avaliação justificada · MISSING = faltam notas · EXEMPT = dispensado */
export type Status = "DONE" | "PENDING" | "MISSING" | "EXEMPT";

export interface MarkLine {
  label: string;
  /** a nota já na escala do modelo (null se não conta) */
  value: number | null;
  counted: boolean;
  note: string | null;
}
export interface ComponentLine {
  key: string;
  name: string;
  /** peso que acabou por contar (depois de repartir o de componentes que saíram) */
  weight: number | null;
  status: Status;
  value: number | null;
  marks: MarkLine[];
  formula: string | null;
  notes: string[];
}
export interface PeriodOutcome {
  status: Status;
  /** antes de arredondar */
  raw: number | null;
  value: number | null;
  level: { key: string; label: string } | null;
  passed: boolean | null;
  components: ComponentLine[];
  formula: string | null;
  notes: string[];
}

// ---------------------------------------------------------------- números

const EPS = 1e-9;
/** Arredonda com as casas e a regra do modelo (as notas nunca são negativas). */
export function roundMark(n: number, decimals: number, rounding: Definition["rounding"]): number {
  const f = 10 ** decimals;
  const x = rounding === "DOWN" ? Math.floor(n * f + EPS) : Math.floor(n * f + 0.5 + EPS);
  return x / f;
}
/** "14,8" · "13,33" · "15" (até duas casas, sem zeros a mais) */
export const fmt = (n: number) => String(Math.round(n * 100 + (n >= 0 ? EPS : -EPS)) / 100).replace(".", ",");
const pct = (w: number) => `${fmt(w)}%`;
const clamp = (n: number, d: Definition) => Math.min(d.scale.max, Math.max(d.scale.min, n));
const sum = (list: number[]) => list.reduce((s, x) => s + x, 0);

export function levelOf(d: Definition, value: number): Level | null {
  let found: Level | null = null;
  for (const l of d.levels) if (l.from !== null && value + EPS >= l.from) found = l;
  return found;
}

// ---------------------------------------------------------------- uma nota

function markLine(d: Definition, m: MarkInput, label: string): MarkLine & { pending: boolean } {
  const base = { label, pending: false };
  if (m.state === "EXEMPT") return { ...base, value: null, counted: false, note: "dispensado: não conta" };
  if (m.state === "ABSENT_JUSTIFIED")
    return d.absences.justified === "PENDING" ? { ...base, value: null, counted: false, pending: true, note: "falta justificada: fica pendente até fazer a avaliação" } : { ...base, value: null, counted: false, note: "falta justificada: não entra na média" };
  if (m.state === "ABSENT")
    return d.absences.unjustified === "ZERO" ? { ...base, value: d.scale.min, counted: true, note: `falta injustificada: conta ${fmt(d.scale.min)}` } : { ...base, value: null, counted: false, note: "falta injustificada: não entra na média" };
  if (m.score === null) return { ...base, value: null, counted: false, pending: true, note: "sem nota lançada" };
  if (m.outOf) {
    const v = clamp(roundMark((m.score / m.outOf) * d.scale.max, d.decimals.mark, d.rounding), d);
    return { ...base, value: v, counted: true, note: `${fmt(m.score)} em ${fmt(m.outOf)} = ${fmt(v)} na escala até ${fmt(d.scale.max)}` };
  }
  return { ...base, value: clamp(roundMark(m.score, d.decimals.mark, d.rounding), d), counted: true, note: null };
}

// ---------------------------------------------------------------- um componente

function componentLine(d: Definition, c: Component, input: MarkInput[], typeNames: Map<string, string>): ComponentLine {
  const notes: string[] = [];
  const lines = input.map((m, i) => ({ m, line: markLine(d, m, m.label?.trim() || (c.aggregation === "BY_TYPE" && m.typeId ? (typeNames.get(m.typeId) ?? "Elemento") : `Avaliação ${i + 1}`)) }));
  const counted = lines.filter((x) => x.line.counted);
  const pending = lines.filter((x) => x.line.pending).length;
  const out = (status: Status, value: number | null, formula: string | null): ComponentLine => ({ key: c.key, name: c.name, weight: c.weight, status, value, marks: lines.map((x) => ({ label: x.line.label, value: x.line.value, counted: x.line.counted, note: x.line.note })), formula, notes });

  if (c.maxItems !== null && input.length > c.maxItems) notes.push(`O modelo admite no máximo ${c.maxItems} ${c.maxItems === 1 ? "avaliação" : "avaliações"} neste componente.`);
  if (input.length > 0 && input.every((m) => m.state === "EXEMPT")) return out("EXEMPT", null, null);
  if (!counted.length && !pending && c.minItems === 0) {
    notes.push("Sem avaliações: não entra na média.");
    return out("EXEMPT", null, null);
  }
  if (counted.length + pending < c.minItems) {
    const n = c.minItems - counted.length - pending;
    notes.push(`${n === 1 ? "Falta 1 avaliação" : `Faltam ${n} avaliações`} (o mínimo ${c.minItems === 1 ? "é 1" : `são ${c.minItems}`}).`);
    return out("MISSING", null, null);
  }
  if (pending) {
    notes.push(pending === 1 ? "Há uma avaliação por fazer." : `Há ${pending} avaliações por fazer.`);
    return out("PENDING", null, null);
  }
  if (!counted.length) {
    notes.push("Nenhuma avaliação conta para a média.");
    return out("MISSING", null, null);
  }
  const values = counted.map((x) => x.line.value!);

  switch (c.aggregation) {
    case "BEST": {
      const v = Math.max(...values);
      return out("DONE", v, counted.length > 1 ? `melhor de ${values.map(fmt).join(", ")} = ${fmt(v)}` : fmt(v));
    }
    case "WEIGHTED": {
      const ws = counted.map((x) => (x.m.weight && x.m.weight > 0 ? x.m.weight : 1));
      const v = sum(values.map((n, i) => n * ws[i])) / sum(ws);
      return out("DONE", v, counted.length > 1 ? `(${values.map((n, i) => `${fmt(n)} × ${fmt(ws[i])}`).join(" + ")}) ÷ ${fmt(sum(ws))} = ${fmt(v)}` : fmt(v));
    }
    case "BY_TYPE": {
      const parts: string[] = [];
      let total = 0;
      for (const p of c.parts) {
        const of = counted.filter((x) => x.m.typeId === p.typeId).map((x) => x.line.value!);
        const name = typeNames.get(p.typeId) ?? "Elemento";
        if (!of.length) {
          notes.push(`Falta pelo menos uma nota de “${name}”.`);
          return out("MISSING", null, null);
        }
        const mean = sum(of) / of.length;
        total += (mean * (p.weight ?? 0)) / 100;
        parts.push(`${name} ${fmt(mean)} × ${pct(p.weight ?? 0)}`);
      }
      const stray = counted.filter((x) => !c.parts.some((p) => p.typeId === x.m.typeId)).length;
      if (stray) notes.push(`${stray === 1 ? "Uma avaliação não é" : `${stray} avaliações não são`} de nenhum elemento deste componente: não conta.`);
      return out("DONE", total, `${parts.join(" + ")} = ${fmt(total)}`);
    }
    default: {
      const v = sum(values) / values.length;
      return out("DONE", v, values.length > 1 ? `(${values.map(fmt).join(" + ")}) ÷ ${values.length} = ${fmt(v)}` : fmt(v));
    }
  }
}

// ---------------------------------------------------------------- o período

/** Média de um período (trimestre ou semestre) numa disciplina. */
export function periodResult(d: Definition, input: PeriodInput, typeNames = new Map<string, string>()): PeriodOutcome {
  const notes: string[] = [];
  const comment = input.comment?.trim() ?? "";
  const needsComment = d.kind !== "NUMERIC" && d.descriptive === "REQUIRED" && !comment;

  if (d.kind === "QUALITATIVE") {
    const level = d.levels.find((l) => l.key === input.level) ?? null;
    if (!level) notes.push("Falta a menção do período.");
    if (needsComment) notes.push("Falta a apreciação escrita do professor (obrigatória).");
    return { status: level && !needsComment ? "DONE" : "MISSING", raw: null, value: null, level: level && { key: level.key, label: level.label }, passed: level ? level.positive : null, components: [], formula: null, notes };
  }

  const components = d.components.map((c) => componentLine(d, c, input.marks.filter((m) => m.component === c.key), typeNames));
  const unknown = input.marks.filter((m) => !d.components.some((c) => c.key === m.component)).length;
  if (unknown) notes.push(`${unknown === 1 ? "Uma nota é" : `${unknown} notas são`} de um componente que este modelo não tem: não conta.`);
  const blank = (status: Status): PeriodOutcome => ({ status, raw: null, value: null, level: null, passed: null, components, formula: null, notes });

  if (components.some((c) => c.status === "MISSING")) return (notes.push("A média do período fica por fazer: faltam notas."), blank("MISSING"));
  if (components.some((c) => c.status === "PENDING")) return (notes.push("A média do período fica pendente até se fazerem as avaliações em falta."), blank("PENDING"));
  const live = components.filter((c) => c.status === "DONE");
  if (!live.length) return (notes.push("Dispensado de todas as avaliações deste período."), blank("EXEMPT"));

  let raw: number;
  let formula: string;
  if (d.weighting === "EQUAL") {
    raw = sum(live.map((c) => c.value!)) / live.length;
    for (const c of components) c.weight = c.status === "DONE" ? 100 / live.length : null;
    formula = live.length > 1 ? `(${live.map((c) => fmt(c.value!)).join(" + ")}) ÷ ${live.length} = ${fmt(raw)}` : fmt(raw);
  } else {
    const base = sum(live.map((c) => c.weight ?? 0));
    if (live.length < components.length) notes.push(`${components.filter((c) => c.status === "EXEMPT").map((c) => c.name).join(", ")} não entra: o peso reparte-se pelos restantes.`);
    for (const c of components) c.weight = c.status === "DONE" ? ((c.weight ?? 0) / base) * 100 : null;
    raw = sum(live.map((c) => (c.value! * c.weight!) / 100));
    formula = `${live.map((c) => `${fmt(c.value!)} × ${pct(c.weight!)}`).join(" + ")} = ${fmt(raw)}`;
  }
  const value = clamp(roundMark(raw, d.decimals.period, d.rounding), d);
  if (value !== roundMark(raw, 2, "HALF_UP")) formula += ` → ${fmt(value)}`;
  const level = levelOf(d, value);
  if (needsComment) notes.push("Falta a apreciação escrita do professor (obrigatória).");
  return { status: needsComment ? "MISSING" : "DONE", raw, value, level: level && { key: level.key, label: level.label }, passed: value + EPS >= d.scale.pass, components, formula, notes };
}

// ---------------------------------------------------------------- o ano

export interface YearInput {
  /** a nota (ou, nos qualitativos, a menção) de cada período, pela ordem */
  periods: { value: number | null; level?: string | null; exempt?: boolean }[];
  /** modelos qualitativos: a menção final (se faltar, conta a do último período) */
  level?: string | null;
  exam?: { state: "GRADED" | "ABSENT" | "ABSENT_JUSTIFIED"; value: number | null; parts?: { key: string; value: number | null }[] } | null;
  recovery?: number | null;
}
export type ExamStatus = "NONE" | "NOT_ADMITTED" | "WAIVED" | "PENDING" | "DONE";
export interface YearOutcome {
  status: Status;
  /** média dos períodos (nota de frequência nas classes de exame) */
  annual: { raw: number | null; value: number | null; formula: string | null };
  exam: { status: ExamStatus; value: number | null; formula: string | null } | null;
  recovery: { eligible: boolean; value: number | null; formula: string | null } | null;
  value: number | null;
  level: { key: string; label: string } | null;
  passed: boolean | null;
  formula: string | null;
  notes: string[];
}

const EXAM: Record<ExamStatus, string> = { NONE: "", NOT_ADMITTED: "Não admitido a exame", WAIVED: "Dispensado do exame", PENDING: "Exame por fazer", DONE: "" };
export const EXAM_STATUS = EXAM;

/** Nota do ano: média dos períodos, exame (se houver) e recuperação (se houver). */
export function yearResult(d: Definition, input: YearInput): YearOutcome {
  const notes: string[] = [];
  const none = { raw: null, value: null, formula: null };

  if (d.kind === "QUALITATIVE") {
    const last = [...input.periods].reverse().find((p) => p.level);
    const key = input.level ?? last?.level ?? null;
    const level = d.levels.find((l) => l.key === key) ?? null;
    if (!input.level && level) notes.push("Sem menção final: conta a do último período.");
    if (!level) notes.push("Falta a menção final.");
    return { status: level ? "DONE" : "MISSING", annual: none, exam: null, recovery: null, value: null, level: level && { key: level.key, label: level.label }, passed: level ? level.positive : null, formula: null, notes };
  }

  const blank = (status: Status, annual = none as YearOutcome["annual"]): YearOutcome => ({ status, annual, exam: null, recovery: null, value: null, level: null, passed: null, formula: null, notes });
  const weights = d.periodWeights;
  if (weights && weights.length !== input.periods.length) {
    notes.push(`O modelo tem pesos para ${weights.length} períodos e o ano tem ${input.periods.length}.`);
    return blank("MISSING");
  }
  const given = input.periods.map((p, i) => ({ i, value: p.exempt ? null : p.value, exempt: !!p.exempt }));
  const missing = given.filter((p) => !p.exempt && p.value === null);
  if (missing.length) {
    notes.push(`Falta a nota do ${missing.map((p) => `${p.i + 1}.º`).join(", ")} período.`);
    return blank("MISSING");
  }
  const live = given.filter((p) => !p.exempt);
  if (!live.length) return (notes.push("Dispensado em todos os períodos."), blank("EXEMPT"));

  let raw: number;
  let formula: string;
  if (weights) {
    const base = sum(live.map((p) => weights[p.i] ?? 0));
    const w = (i: number) => ((weights[i] ?? 0) / base) * 100;
    raw = sum(live.map((p) => (p.value! * w(p.i)) / 100));
    formula = `${live.map((p) => `${fmt(p.value!)} × ${pct(w(p.i))}`).join(" + ")} = ${fmt(raw)}`;
  } else {
    raw = sum(live.map((p) => p.value!)) / live.length;
    formula = live.length > 1 ? `(${live.map((p) => fmt(p.value!)).join(" + ")}) ÷ ${live.length} = ${fmt(raw)}` : fmt(raw);
  }
  const annualValue = clamp(roundMark(raw, d.decimals.final, d.rounding), d);
  if (annualValue !== roundMark(raw, 2, "HALF_UP")) formula += ` → ${fmt(annualValue)}`;
  const annual = { raw, value: annualValue, formula };

  // ---- exame
  let value = annualValue;
  let finalFormula: string | null = null;
  let exam: YearOutcome["exam"] = null;
  if (d.exam.enabled) {
    const e = d.exam;
    if (e.minFrequency !== null && annualValue + EPS < e.minFrequency) {
      exam = { status: "NOT_ADMITTED", value: null, formula: null };
      notes.push(`Frequência ${fmt(annualValue)}: abaixo de ${fmt(e.minFrequency)}, não vai a exame e a nota final é a de frequência.`);
    } else if (e.waiveFrom !== null && annualValue + EPS >= e.waiveFrom) {
      exam = { status: "WAIVED", value: null, formula: null };
      notes.push(`Frequência ${fmt(annualValue)}: a partir de ${fmt(e.waiveFrom)} dispensa o exame; a nota final é a de frequência.`);
    } else {
      const x = input.exam ?? null;
      let examValue: number | null = null;
      let examFormula: string | null = null;
      if (x?.state === "ABSENT") {
        examValue = d.scale.min;
        examFormula = `faltou: conta ${fmt(d.scale.min)}`;
      } else if (x?.state === "GRADED" && e.parts.length) {
        const parts = e.parts.map((p) => ({ p, v: x.parts?.find((y) => y.key === p.key)?.value ?? null }));
        if (parts.every((y) => y.v !== null)) {
          examValue = clamp(roundMark(sum(parts.map((y) => (y.v! * (y.p.weight ?? 0)) / 100)), d.decimals.mark, d.rounding), d);
          examFormula = `${parts.map((y) => `${y.p.name} ${fmt(y.v!)} × ${pct(y.p.weight ?? 0)}`).join(" + ")} = ${fmt(examValue)}`;
        }
      } else if (x?.state === "GRADED" && x.value !== null) {
        examValue = clamp(roundMark(x.value, d.decimals.mark, d.rounding), d);
        examFormula = fmt(examValue);
      }
      if (examValue === null) {
        exam = { status: "PENDING", value: null, formula: null };
        notes.push(x?.state === "ABSENT_JUSTIFIED" ? "Faltou ao exame com justificação: fica pendente da 2.ª chamada." : "Falta a nota do exame.");
        return { ...blank("PENDING", annual), exam };
      }
      exam = { status: "DONE", value: examValue, formula: examFormula };
      const rawFinal = (annualValue * (e.frequencyWeight ?? 0) + examValue * (e.examWeight ?? 0)) / 100;
      value = clamp(roundMark(rawFinal, d.decimals.final, d.rounding), d);
      finalFormula = `frequência ${fmt(annualValue)} × ${pct(e.frequencyWeight ?? 0)} + exame ${fmt(examValue)} × ${pct(e.examWeight ?? 0)} = ${fmt(rawFinal)}${value !== roundMark(rawFinal, 2, "HALF_UP") ? ` → ${fmt(value)}` : ""}`;
    }
  }

  // ---- recuperação
  let recovery: YearOutcome["recovery"] = null;
  const r = d.recovery;
  if (r.enabled && value + EPS < d.scale.pass) {
    const eligible = r.minMark === null || value + EPS >= r.minMark;
    if (!eligible) {
      recovery = { eligible: false, value: null, formula: null };
      notes.push(`Nota ${fmt(value)}: abaixo de ${fmt(r.minMark!)}, não pode ir à recuperação.`);
    } else if (input.recovery === null || input.recovery === undefined) {
      recovery = { eligible: true, value: null, formula: null };
      notes.push(`Nota ${fmt(value)}: pode ir à prova de recuperação${r.maxSubjects ? ` (no máximo ${r.maxSubjects} disciplinas por aluno)` : ""}.`);
    } else {
      const got = clamp(roundMark(input.recovery, d.decimals.mark, d.rounding), d);
      const before = value;
      if (r.result === "REPLACE") value = clamp(roundMark(got, d.decimals.final, d.rounding), d);
      else if (r.result === "BEST") value = clamp(roundMark(Math.max(before, got), d.decimals.final, d.rounding), d);
      else value = clamp(roundMark((before + got) / 2, d.decimals.final, d.rounding), d);
      const how = r.result === "REPLACE" ? `a recuperação (${fmt(got)}) substitui ${fmt(before)}` : r.result === "BEST" ? `a melhor entre ${fmt(before)} e ${fmt(got)}` : `(${fmt(before)} + ${fmt(got)}) ÷ 2 = ${fmt((before + got) / 2)}`;
      recovery = { eligible: true, value: got, formula: `${how} → ${fmt(value)}` };
    }
  }

  const level = levelOf(d, value);
  return { status: "DONE", annual, exam, recovery, value, level: level && { key: level.key, label: level.label }, passed: value + EPS >= d.scale.pass, formula: finalFormula, notes };
}
