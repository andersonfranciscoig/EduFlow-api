import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { fmt, type MarkInput, type PeriodOutcome, periodResult, type YearInput, type YearOutcome, yearResult } from "../domain/engine";
import { type Definition, type GradingError, gradingError, problemsOf } from "../domain/model";
import type { PrismaGradingSettingsRepository } from "../infrastructure/prisma-grading-settings";

export const MAX_SIMULATED_MARKS = 120;
export interface SimulationInput {
  /** o que se simula: o rascunho, a versão em vigor ou uma versão antiga */
  source: "draft" | "current" | number;
  period: { marks: MarkInput[]; level?: string | null; comment?: string | null };
  /** a nota do ano: o período em detalhe fica na posição `position`; os outros dão-se já feitos */
  year?: {
    count: number;
    position: number;
    others: { value: number | null; level?: string | null; exempt?: boolean }[];
    level?: string | null;
    exam?: YearInput["exam"];
    recovery?: number | null;
  } | null;
}
export interface SimulationResult {
  model: { id: string; name: string };
  used: { label: string; version: number | null };
  period: PeriodOutcome;
  year: YearOutcome | null;
}

const bad = (m: string) => fail(gradingError("INVALID_INPUT", m));

/**
 * Simulador: o motor oficial com notas de exemplo, para o colégio confirmar um modelo (mesmo por
 * publicar) antes de o usar com alunos. Não grava nada.
 */
export class GradingSimulator {
  async simulate(repo: PrismaGradingSettingsRepository, modelId: string, input: SimulationInput): Promise<Result<SimulationResult, GradingError>> {
    const m = await repo.model(modelId);
    if (!m) return fail(gradingError("NOT_FOUND", "Modelo não encontrado."));
    let d: Definition | null;
    let used: SimulationResult["used"];
    if (input.source === "draft") {
      d = m.draft ?? m.current;
      used = m.draft ? { label: m.currentVersion ? "Alterações por publicar" : "Rascunho", version: null } : { label: `Versão ${m.currentVersion}`, version: m.currentVersion };
    } else if (input.source === "current") {
      if (!m.current) return fail(gradingError("INVALID_STATE", "Este modelo ainda não foi publicado: simule o rascunho."));
      d = m.current;
      used = { label: `Versão ${m.currentVersion}`, version: m.currentVersion };
    } else {
      const v = (await repo.versions(modelId)).find((x) => x.number === input.source);
      if (!v) return fail(gradingError("NOT_FOUND", "Versão não encontrada."));
      d = v.definition;
      used = { label: `Versão ${v.number}`, version: v.number };
    }
    if (!d) return fail(gradingError("NOT_FOUND", "Modelo não encontrado."));
    const problems = problemsOf(d);
    if (problems.length) return fail(gradingError("INCOMPLETE", `Complete o modelo antes de simular: ${problems[0].message}`, { problems }));

    const checked = this.check(d, input);
    if (!checked.ok) return checked;
    const types = new Map((await repo.types()).map((t) => [t.id, t.name]));
    const period = periodResult(d, input.period, types);
    let year: YearOutcome | null = null;
    if (input.year) {
      const y = input.year;
      const mine = { value: period.value, level: period.level?.key ?? null, exempt: period.status === "EXEMPT" };
      const periods = [...y.others.slice(0, y.position - 1), mine, ...y.others.slice(y.position - 1)];
      year = yearResult(d, { periods, level: y.level, exam: y.exam, recovery: y.recovery });
    }
    return ok({ model: { id: m.id, name: m.name }, used, period, year });
  }

  private check(d: Definition, input: SimulationInput): Result<true, GradingError> {
    const { min, max } = d.scale;
    const inScale = (n: number | null | undefined) => n === null || n === undefined || (n >= min && n <= max);
    const scaleText = `de ${fmt(min)} a ${fmt(max)}`;
    const p = input.period;
    if (p.marks.length > MAX_SIMULATED_MARKS) return bad(`No máximo ${MAX_SIMULATED_MARKS} notas numa simulação.`);
    for (const x of p.marks) {
      const c = d.components.find((y) => y.key === x.component);
      if (!c) return bad("Há uma nota de um componente que este modelo não tem.");
      if (x.outOf !== null && x.outOf !== undefined) {
        if (x.outOf <= 0 || x.outOf > 1000) return bad("A cotação máxima de uma avaliação vai até 1000.");
        if (x.score !== null && (x.score < 0 || x.score > x.outOf)) return bad(`Em “${c.name}”, a nota não pode passar da cotação (${fmt(x.outOf)}).`);
      } else if (!inScale(x.score)) return bad(`Em “${c.name}”, as notas vão ${scaleText}.`);
      if (c.aggregation === "BY_TYPE" && x.state !== "EXEMPT" && !c.parts.some((y) => y.typeId === x.typeId)) return bad(`Em “${c.name}”, diga de que elemento é cada nota.`);
      if (x.weight !== null && x.weight !== undefined && (x.weight <= 0 || x.weight > 100)) return bad("O peso de uma avaliação vai de 1 a 100.");
    }
    const levelOk = (k: string | null | undefined) => !k || d.levels.some((l) => l.key === k);
    if (!levelOk(p.level)) return bad("Menção desconhecida.");
    if ((p.comment?.length ?? 0) > 1000) return bad("A apreciação tem no máximo 1000 caracteres.");
    const y = input.year;
    if (y) {
      const count = d.periodWeights?.length ?? y.count;
      if (count !== y.count || y.count < 2 || y.count > 3) return bad(d.periodWeights ? `Este modelo junta ${d.periodWeights.length} períodos.` : "O ano tem 2 semestres ou 3 trimestres.");
      if (y.position < 1 || y.position > y.count || y.others.length !== y.count - 1) return bad("Indique as notas dos outros períodos.");
      if (!y.others.every((o) => inScale(o.value) && levelOk(o.level))) return bad(`As notas dos períodos vão ${scaleText}.`);
      if (!levelOk(y.level)) return bad("Menção desconhecida.");
      if (y.exam) {
        if (!inScale(y.exam.value) || !(y.exam.parts ?? []).every((x) => inScale(x.value))) return bad(`A nota do exame vai ${scaleText}.`);
        if ((y.exam.parts ?? []).some((x) => !d.exam.parts.some((q) => q.key === x.key))) return bad("Há uma prova do exame que este modelo não tem.");
      }
      if (!inScale(y.recovery)) return bad(`A nota da recuperação vai ${scaleText}.`);
    }
    return ok(true);
  }
}
