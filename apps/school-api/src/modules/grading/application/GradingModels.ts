import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import { QUALIFICATION_LEVELS, type QualificationLevel } from "../../pedagogy/domain/qualifications";
import {
  AGGREGATIONS,
  changesBetween,
  checkDefinition,
  checkName,
  checkTypeName,
  cleanText,
  type Definition,
  DESCRIPTIVE,
  type GradingError,
  gradingError,
  JUSTIFIED,
  MAX_COMPONENTS,
  MAX_LEVELS,
  MAX_MODELS,
  MAX_REASON,
  MAX_TYPES,
  MODEL_KINDS,
  PRESETS,
  problemsOf,
  RECOVERY_RESULTS,
  ROUNDINGS,
  same,
  SOURCES,
  summaryOf,
  TYPE_SUGGESTIONS,
  UNJUSTIFIED,
  WEIGHTINGS,
} from "../domain/model";
import type { ModelRow, PrismaGradingSettingsRepository } from "../infrastructure/prisma-grading-settings";

type R<T> = Promise<Result<T, GradingError>>;
type Repo = PrismaGradingSettingsRepository;
export interface GradingActor {
  /** null numa sessão de suporte */
  id: string | null;
  canManage: boolean;
}

export const forbidden = () => fail(gradingError("FORBIDDEN", "Não tem permissão para configurar os critérios de avaliação."));
const missing = () => fail(gradingError("NOT_FOUND", "Modelo não encontrado."));
const changed = () => fail(gradingError("CHANGED", "Este modelo foi alterado entretanto noutra janela. Atualize a página."));
const taken = () => fail(gradingError("NAME_TAKEN", "Já existe um modelo com este nome (pode estar arquivado)."));
const options = <T extends Record<string, { label: string; hint: string }>>(o: T) => Object.entries(o).map(([value, x]) => ({ value, label: x.label, hint: x.hint }));
const simple = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));
const HISTORY: Record<string, string> = { GRADING_MODEL_CREATED: "Criado", GRADING_MODEL_PUBLISHED: "Publicado", GRADING_MODEL_ARCHIVED: "Arquivado", GRADING_MODEL_RESTORED: "Voltou a ativo" };
export const gradeName = (grade: number, course: string | null) => `${grade === 0 ? "Iniciação" : `${grade}.ª Classe`}${course ? ` · ${course}` : ""}`;

/** Modelos de avaliação do colégio: rascunho → publicar (versão imutável) → arquivar; e os elementos de avaliação. */
export class GradingModels {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private dto(m: ModelRow) {
    const d = m.draft ?? m.current!;
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      status: m.archivedAt ? "ARCHIVED" : m.currentVersion ? "PUBLISHED" : "DRAFT",
      statusLabel: m.archivedAt ? "Arquivado" : m.currentVersion ? "Em vigor" : "Em preparação",
      version: m.currentVersion,
      hasDraft: !!m.draft,
      kind: d.kind,
      kindLabel: MODEL_KINDS[d.kind].label,
      /** o que está em vigor (ou, se nunca foi publicado, o que se prepara) */
      summary: summaryOf(m.current ?? d),
      exam: (m.current ?? d).exam.enabled,
      openRules: m.openRules,
      updatedAt: m.updatedAt.toISOString(),
      updatedBy: m.updatedByName,
    };
  }

  async overview(repo: Repo, actor: GradingActor) {
    const [models, types] = await Promise.all([repo.models(), repo.types()]);
    const names = new Set(types.filter((t) => !t.archived).map((t) => t.name.toLowerCase()));
    return {
      can: { manage: actor.canManage },
      max: { models: MAX_MODELS, types: MAX_TYPES },
      models: models.map((m) => this.dto(m)),
      presets: PRESETS.map((p) => ({ key: p.key, name: p.name, hint: p.hint, kindLabel: MODEL_KINDS[p.definition.kind].label })),
      types,
      suggestions: TYPE_SUGGESTIONS.filter((s) => !names.has(s.toLowerCase())),
    };
  }

  async detail(repo: Repo, actor: GradingActor, id: string) {
    const m = await repo.model(id);
    if (!m) return missing();
    const [versions, uses, types, history] = await Promise.all([repo.versions(id), repo.uses(id), repo.types(), repo.history(id, Object.keys(HISTORY))]);
    const d = m.draft ?? m.current!;
    return ok({
      ...this.dto(m),
      revision: m.revision,
      can: { edit: actor.canManage && !m.archivedAt, archive: actor.canManage && !m.archivedAt && !!m.currentVersion && !m.openRules, remove: actor.canManage && !m.currentVersion && !m.rules, restore: actor.canManage && !!m.archivedAt },
      definition: d,
      problems: problemsOf(d),
      /** o que muda em relação à versão em vigor */
      changes: m.draft && m.current ? changesBetween(m.current, m.draft) : [],
      types: types.map((t) => ({ id: t.id, name: t.name, archived: t.archived })),
      versions: versions.map((v) => ({ number: v.number, summary: summaryOf(v.definition), reason: v.reason, at: v.publishedAt.toISOString(), by: v.publishedByName })),
      uses: uses.map((u) => ({
        year: u.yearName,
        where: u.level ? QUALIFICATION_LEVELS[u.level as QualificationLevel].label : u.courseName ? `Curso ${u.courseName}` : u.grade !== null ? gradeName(u.grade, u.classCourse) : "Todo o colégio",
        subject: u.subjectName,
        period: u.period ? periodName(u.periodKind as PeriodKind, u.period) : null,
      })),
      history: history.map((h) => ({
        at: h.at.toISOString(),
        by: h.by,
        label: h.type === "GRADING_MODEL_PUBLISHED" ? `Publicada a versão ${String(h.details?.version ?? "")}` : (HISTORY[h.type] ?? h.type),
        reason: typeof h.details?.reason === "string" ? h.details.reason : null,
        changes: Array.isArray(h.details?.changes) ? (h.details.changes as string[]) : [],
      })),
      options: {
        kinds: options(MODEL_KINDS),
        weightings: options(WEIGHTINGS),
        sources: options(SOURCES),
        aggregations: options(AGGREGATIONS),
        roundings: options(ROUNDINGS),
        unjustified: simple(UNJUSTIFIED),
        justified: simple(JUSTIFIED),
        recovery: simple(RECOVERY_RESULTS),
        descriptive: simple(DESCRIPTIVE),
        maxComponents: MAX_COMPONENTS,
        maxLevels: MAX_LEVELS,
      },
    });
  }

  /** A partir de um modelo sugerido, ou de uma cópia de outro do colégio. */
  async create(repo: Repo, actor: GradingActor, input: { name: string; preset?: string | null; copyOf?: string | null }): R<{ id: string }> {
    if (!actor.canManage) return forbidden();
    const name = checkName(input.name);
    if (!name.ok) return name;
    let definition: Definition;
    let from: string;
    if (input.copyOf) {
      const source = await repo.model(input.copyOf);
      if (!source) return missing();
      definition = source.current ?? source.draft!;
      from = source.name;
    } else {
      const preset = PRESETS.find((p) => p.key === input.preset);
      if (!preset) return fail(gradingError("INVALID_INPUT", "Escolha por onde começar."));
      definition = preset.definition;
      from = preset.name;
    }
    if ((await repo.models()).filter((m) => !m.archivedAt).length >= MAX_MODELS) return fail(gradingError("INVALID_STATE", `No máximo ${MAX_MODELS} modelos ativos: arquive os que já não usa.`));
    const id = this.ids.next();
    return (await repo.createModel({ id, name: name.value, description: null, definition, from }, actor.id, this.clock.now())) === "taken" ? taken() : ok({ id });
  }

  /** Grava o rascunho (mesmo incompleto): devolve o que falta para publicar. */
  async saveDraft(repo: Repo, actor: GradingActor, id: string, input: { revision: number; name: string; description?: string | null; definition: Definition }) {
    if (!actor.canManage) return forbidden();
    const m = await repo.model(id);
    if (!m) return missing();
    if (m.archivedAt) return fail(gradingError("INVALID_STATE", "Este modelo está arquivado."));
    const name = checkName(input.name);
    if (!name.ok) return name;
    const description = cleanText(input.description) || null;
    if (description && description.length > 300) return fail(gradingError("INVALID_INPUT", "A descrição tem no máximo 300 caracteres."));
    const d = checkDefinition(input.definition, new Set((await repo.types()).map((t) => t.id)));
    if (!d.ok) return d;
    // igual ao que está em vigor: não há nada por publicar
    const draft = m.current && same(m.current, d.value) ? null : d.value;
    const r = await repo.saveDraft(id, input.revision, { name: name.value, description, draft }, actor.id, this.clock.now());
    if (r === "taken") return taken();
    if (r === "changed") return changed();
    return ok({ revision: input.revision + 1, problems: problemsOf(d.value), changes: draft && m.current ? changesBetween(m.current, d.value) : [], hasDraft: !!draft });
  }

  /** Deita fora o rascunho: volta ao que está em vigor. */
  async discardDraft(repo: Repo, actor: GradingActor, id: string, revision: number): R<{ discarded: true }> {
    if (!actor.canManage) return forbidden();
    const m = await repo.model(id);
    if (!m) return missing();
    if (!m.draft) return fail(gradingError("INVALID_STATE", "Este modelo não tem alterações por publicar."));
    if (!m.currentVersion) return fail(gradingError("INVALID_STATE", "Este modelo nunca foi publicado: pode apagá-lo."));
    return (await repo.saveDraft(id, revision, { name: m.name, description: m.description, draft: null }, actor.id, this.clock.now())) === "ok" ? ok({ discarded: true as const }) : changed();
  }

  /** Publica: cria uma versão imutável. Se o modelo já está em uso, pede confirmação e motivo. */
  async publish(repo: Repo, actor: GradingActor, id: string, input: { revision: number; reason?: string | null; confirm?: boolean | null }): R<{ version: number }> {
    if (!actor.canManage) return forbidden();
    const m = await repo.model(id);
    if (!m) return missing();
    if (m.archivedAt) return fail(gradingError("INVALID_STATE", "Este modelo está arquivado."));
    if (!m.draft) return fail(gradingError("INVALID_STATE", "Não há alterações por publicar."));
    const d = checkDefinition(m.draft, new Set((await repo.types()).map((t) => t.id)));
    if (!d.ok) return d;
    const problems = problemsOf(d.value);
    if (problems.length) return fail(gradingError("INCOMPLETE", problems[0].message, { problems }));
    const reason = cleanText(input.reason) || null;
    if (reason && reason.length > MAX_REASON) return fail(gradingError("INVALID_INPUT", `O motivo tem no máximo ${MAX_REASON} caracteres.`));
    if (m.currentVersion && (!reason || reason.length < 3)) return fail(gradingError("INVALID_INPUT", "Indique o motivo da alteração: fica no histórico."));
    if (m.openRules && !input.confirm)
      return fail(gradingError("NEEDS_CONFIRMATION", `Este modelo está em uso (${m.openRules} ${m.openRules === 1 ? "aplicação" : "aplicações"}). A nova versão passa a valer nos períodos ainda abertos; os encerrados ficam como estavam.`));
    const number = (m.currentVersion ?? 0) + 1;
    const done = await repo.publish(id, input.revision, number, d.value, reason, m.current ? changesBetween(m.current, d.value) : [], actor.id, this.clock.now());
    return done ? ok({ version: number }) : changed();
  }

  /** Nunca publicado: apaga-se. Publicado: arquiva-se (se nenhum ano aberto o usa). */
  async remove(repo: Repo, actor: GradingActor, id: string): R<{ result: "removed" | "archived" }> {
    if (!actor.canManage) return forbidden();
    const m = await repo.model(id);
    if (!m) return missing();
    if (!m.currentVersion) return (await repo.deleteModel(id)) ? ok({ result: "removed" as const }) : fail(gradingError("IN_USE", "Este modelo já está a ser usado."));
    if (m.openRules) return fail(gradingError("IN_USE", "Este modelo aplica-se a classes de um ano letivo aberto: mude-as primeiro."));
    return (await repo.setArchived(id, true, actor.id, this.clock.now())) ? ok({ result: "archived" as const }) : changed();
  }
  async restore(repo: Repo, actor: GradingActor, id: string): R<{ restored: true }> {
    if (!actor.canManage) return forbidden();
    if (!(await repo.model(id))) return missing();
    return (await repo.setArchived(id, false, actor.id, this.clock.now())) ? ok({ restored: true as const }) : changed();
  }

  // ================================================================ elementos de avaliação

  async addTypes(repo: Repo, actor: GradingActor, names: string[]): R<{ added: number }> {
    if (!actor.canManage) return forbidden();
    const list: string[] = [];
    for (const raw of names) {
      const n = checkTypeName(raw);
      if (!n.ok) return n;
      if (!list.some((x) => x.toLowerCase() === n.value.toLowerCase())) list.push(n.value);
    }
    const active = (await repo.types()).filter((t) => !t.archived);
    const fresh = list.filter((n) => !active.some((t) => t.name.toLowerCase() === n.toLowerCase()));
    if (!fresh.length) return fail(gradingError("NAME_TAKEN", "Já existe um elemento com este nome."));
    if (active.length + fresh.length > MAX_TYPES) return fail(gradingError("INVALID_STATE", `No máximo ${MAX_TYPES} elementos de avaliação.`));
    await repo.addTypes(fresh, actor.id, this.clock.now());
    return ok({ added: fresh.length });
  }
  async renameType(repo: Repo, actor: GradingActor, id: string, raw: string): R<{ saved: true }> {
    if (!actor.canManage) return forbidden();
    const name = checkTypeName(raw);
    if (!name.ok) return name;
    const r = await repo.renameType(id, name.value, actor.id, this.clock.now());
    if (r === "taken") return fail(gradingError("NAME_TAKEN", "Já existe um elemento com este nome."));
    return r === "missing" ? fail(gradingError("NOT_FOUND", "Elemento não encontrado.")) : ok({ saved: true as const });
  }
  async removeType(repo: Repo, actor: GradingActor, id: string): R<{ result: "removed" | "archived" }> {
    if (!actor.canManage) return forbidden();
    const r = await repo.removeType(id, actor.id, this.clock.now());
    return r === "missing" ? fail(gradingError("NOT_FOUND", "Elemento não encontrado.")) : ok({ result: r });
  }
  async restoreType(repo: Repo, actor: GradingActor, id: string): R<{ saved: true }> {
    if (!actor.canManage) return forbidden();
    return (await repo.restoreType(id)) ? ok({ saved: true as const }) : fail(gradingError("NOT_FOUND", "Elemento não encontrado."));
  }
}
