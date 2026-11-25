import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { PERIOD_KINDS, periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import { QUALIFICATION_LEVELS, type QualificationLevel } from "../../pedagogy/domain/qualifications";
import { type Definition, type GradingError, gradingError, summaryOf } from "../domain/model";
import { levelOf, originOf, resolve, type Rule, sameScale, type Scope } from "../domain/rules";
import type { ClassRow, ModelRow, PrismaGradingSettingsRepository, YearRow } from "../infrastructure/prisma-grading-settings";
import { forbidden, gradeName, type GradingActor } from "./GradingModels";

type R<T> = Promise<Result<T, GradingError>>;
type Repo = PrismaGradingSettingsRepository;
const bad = (m: string) => fail(gradingError("INVALID_INPUT", m));
export const MAX_SCOPES = 200;

export interface RuleIssue {
  code: "NO_MODEL" | "SCALE" | "PERIODS";
  classId: string;
  subjectId: string | null;
  message: string;
}

/** Que modelo se aplica a cada classe e disciplina de um ano letivo, com herança, e o que não bate certo. */
export class GradingRules {
  constructor(private readonly clock: Clock) {}

  private current(years: YearRow[]) {
    return years.find((y) => y.status === "ACTIVE") ?? [...years].reverse().find((y) => y.status !== "CLOSED") ?? years[0];
  }

  /** Cada disciplina de cada classe tem um modelo? As escalas e os períodos batem certo? */
  private issues(year: YearRow, classes: ClassRow[], rules: Rule[], models: Map<string, Definition>): RuleIssue[] {
    const kind = year.periodKind as PeriodKind;
    const count = PERIOD_KINDS[kind].count;
    const out: RuleIssue[] = [];
    for (const c of classes) {
      const name = gradeName(c.grade, c.courseName);
      for (const s of c.subjects) {
        const base = resolve(rules, c, s.id, null);
        const periods = Array.from({ length: count }, (_, i) => resolve(rules, c, s.id, i + 1));
        if (!base && periods.some((p) => !p)) {
          out.push({ code: "NO_MODEL", classId: c.id, subjectId: s.id, message: `${name} · ${s.name}: sem modelo de avaliação.` });
          continue;
        }
        const defs = [base, ...periods].flatMap((r) => (r && models.has(r.modelId) ? [models.get(r.modelId)!] : []));
        if (defs.some((d) => !sameScale(d, defs[0]))) out.push({ code: "SCALE", classId: c.id, subjectId: s.id, message: `${name} · ${s.name}: os períodos têm modelos com escalas diferentes, e as notas não se juntam.` });
        const annual = defs[0];
        if (annual?.periodWeights && annual.periodWeights.length !== count)
          out.push({ code: "PERIODS", classId: c.id, subjectId: s.id, message: `${name} · ${s.name}: o modelo reparte o ano por ${annual.periodWeights.length} períodos, mas este ano tem ${count} ${PERIOD_KINDS[kind].label.toLowerCase()}.` });
      }
    }
    return out;
  }

  private definitions(models: ModelRow[]) {
    return new Map(models.flatMap((m) => (m.current ? [[m.id, m.current] as const] : [])));
  }

  async overview(repo: Repo, actor: GradingActor, yearId?: string) {
    const years = await repo.years();
    const year = years.find((y) => y.id === yearId) ?? this.current(years);
    const yearsDto = years.map((y) => ({ id: y.id, name: y.name, status: y.status }));
    if (!year) return { can: { manage: false }, years: yearsDto, year: null, periods: [], models: [], levels: [], school: null, classes: [], issues: [], copyFrom: null, history: [] };
    const [classes, rules, models, history] = await Promise.all([repo.classes(year.id), repo.rules(year.id), repo.models(), repo.history(year.id, ["GRADING_RULES_SET", "GRADING_RULES_COPIED"], 20)]);
    const kind = year.periodKind as PeriodKind;
    const positions = Array.from({ length: PERIOD_KINDS[kind].count }, (_, i) => i + 1);
    const byId = new Map(models.map((m) => [m.id, m]));
    const issues = this.issues(year, classes, rules, this.definitions(models));
    const ref = (r: Rule | null) => (r ? { modelId: r.modelId, name: byId.get(r.modelId)?.name ?? "—", origin: originOf(r) } : null);
    const exact = (s: Partial<Scope>) => {
      const w = { level: null, courseId: null, classId: null, subjectId: null, period: null, ...s };
      return rules.find((r) => r.level === w.level && r.courseId === w.courseId && r.classId === w.classId && r.subjectId === w.subjectId && r.period === w.period) ?? null;
    };
    const own = (s: Partial<Scope>) => ({ all: exact(s)?.modelId ?? null, periods: positions.flatMap((p) => (exact({ ...s, period: p }) ? [{ position: p, modelId: exact({ ...s, period: p })!.modelId }] : [])) });
    // um ano ainda sem nada pode começar como o anterior mais próximo que tenha modelos aplicados
    let copyFrom: { id: string; name: string } | null = null;
    if (!rules.length && year.status !== "CLOSED")
      for (const y of years.slice(years.findIndex((x) => x.id === year.id) + 1))
        if ((await repo.rules(y.id)).length) {
          copyFrom = { id: y.id, name: y.name };
          break;
        }
    return {
      can: { manage: actor.canManage && year.status !== "CLOSED" },
      years: yearsDto,
      year: { id: year.id, name: year.name, status: year.status, periodKind: kind, periodKindLabel: PERIOD_KINDS[kind].label },
      periods: positions.map((p) => ({ position: p, name: periodName(kind, p) })),
      models: models.filter((m) => m.current && (!m.archivedAt || m.openRules)).map((m) => ({ id: m.id, name: m.name, summary: summaryOf(m.current!), kind: m.current!.kind, available: !m.archivedAt })),
      school: own({}),
      levels: (Object.keys(QUALIFICATION_LEVELS) as QualificationLevel[]).map((key) => ({ key, label: QUALIFICATION_LEVELS[key].label, own: own({ level: key }) })),
      courses: [...new Map(classes.flatMap((c) => (c.courseId ? [[c.courseId, c.courseName!] as const] : []))).entries()].map(([id, name]) => ({ id, name, own: own({ courseId: id }) })),
      classes: classes.map((c) => ({
        id: c.id,
        grade: c.grade,
        level: levelOf(c.grade),
        courseId: c.courseId,
        courseName: c.courseName,
        label: gradeName(c.grade, c.courseName),
        groups: c.groups,
        own: own({ classId: c.id }),
        resolved: ref(resolve(rules, c, null, null)),
        subjects: c.subjects.map((s) => ({
          ...s,
          own: own({ classId: c.id, subjectId: s.id }),
          /** a disciplina em todo este ensino */
          ownLevel: own({ level: levelOf(c.grade), subjectId: s.id }),
          resolved: ref(resolve(rules, c, s.id, null)),
          /** só os períodos em que muda */
          periods: positions.flatMap((p) => {
            const r = resolve(rules, c, s.id, p);
            return r && r.modelId !== resolve(rules, c, s.id, null)?.modelId ? [{ position: p, ...ref(r)! }] : [];
          }),
        })),
      })),
      issues,
      copyFrom,
      history: history.map((h) => ({ at: h.at.toISOString(), by: h.by, text: typeof h.details?.text === "string" ? h.details.text : h.type === "GRADING_RULES_COPIED" ? `Copiadas ${String(h.details?.created ?? 0)} aplicações de ${String(h.details?.from ?? "")}` : "Aplicação alterada" })),
    };
  }

  /** Aplica um modelo (ou volta a herdar, modelId null) aos sítios indicados. */
  async set(repo: Repo, actor: GradingActor, yearId: string, input: { scopes: Scope[]; modelId: string | null }): R<{ saved: number; issues: number }> {
    if (!actor.canManage) return forbidden();
    const scopes = input.scopes;
    if (!scopes.length || scopes.length > MAX_SCOPES) return bad("Escolha onde se aplica.");
    return repo.locked(yearId, async (tx) => {
      const [years, classes, rules, models] = await Promise.all([tx.years(), tx.classes(yearId), tx.rules(yearId), tx.models()]);
      const year = years.find((y) => y.id === yearId);
      if (!year) return fail(gradingError("NOT_FOUND", "Ano letivo não encontrado."));
      if (year.status === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
      const model = input.modelId ? models.find((m) => m.id === input.modelId) : null;
      if (input.modelId && (!model?.current || model.archivedAt)) return fail(gradingError("INVALID_STATE", "Só se aplica um modelo publicado e não arquivado."));
      const kind = year.periodKind as PeriodKind;
      const courses = new Map(classes.flatMap((c) => (c.courseId ? [[c.courseId, c.courseName!] as const] : [])));
      const subjects = new Map(classes.flatMap((c) => c.subjects.map((s) => [s.id, s.name] as const)));
      const labels: string[] = [];
      for (const s of scopes) {
        if ([s.level, s.courseId, s.classId].filter(Boolean).length > 1) return bad("Escolha o ensino, o curso ou a classe: só um.");
        const cls = s.classId ? classes.find((c) => c.id === s.classId) : null;
        if (s.classId && !cls) return bad("Uma das classes não é deste ano letivo.");
        if (s.courseId && !courses.has(s.courseId)) return bad("Este curso não tem classes neste ano letivo.");
        if (s.subjectId && !(cls ? cls.subjects.some((x) => x.id === s.subjectId) : subjects.has(s.subjectId))) return bad("Uma das disciplinas não faz parte do plano curricular.");
        if (s.period && (s.period < 1 || s.period > PERIOD_KINDS[kind].count)) return bad("Esse período não existe neste ano letivo.");
        labels.push([s.level ? QUALIFICATION_LEVELS[s.level].label : s.courseId ? `Curso ${courses.get(s.courseId)}` : cls ? gradeName(cls.grade, cls.courseName) : "Todo o colégio", s.subjectId ? subjects.get(s.subjectId) : null, s.period ? periodName(kind, s.period) : null].filter(Boolean).join(" · "));
      }
      const key = (s: Scope) => [s.level, s.courseId, s.classId, s.subjectId, s.period].join("|");
      const touched = new Set(scopes.map(key));
      const next = [...rules.filter((r) => !touched.has(key(r))), ...(input.modelId ? scopes.map((s, i) => ({ ...s, id: `novo-${i}`, modelId: input.modelId! })) : [])];
      const defs = this.definitions(models);
      const before = this.issues(year, classes, rules, defs);
      const after = this.issues(year, classes, next, defs);
      const known = new Set(before.filter((i) => i.code === "SCALE").map((i) => `${i.classId}|${i.subjectId}`));
      const clash = after.find((i) => i.code === "SCALE" && !known.has(`${i.classId}|${i.subjectId}`));
      if (clash) return fail(gradingError("INVALID_STATE", clash.message));
      const where = labels.length > 4 ? `${labels.slice(0, 4).join("; ")} e mais ${labels.length - 4}` : labels.join("; ");
      await tx.setRules(yearId, scopes, input.modelId, actor.id, this.clock.now(), { text: model ? `${where}: ${model.name}` : `${where}: volta a herdar`, modelId: input.modelId, scopes });
      return ok({ saved: scopes.length, issues: after.length });
    });
  }

  /** Um ano novo começa como o anterior: as mesmas aplicações, com as classes do ano (classe + curso). */
  async copy(repo: Repo, actor: GradingActor, yearId: string, fromId: string): R<{ created: number; skipped: number }> {
    if (!actor.canManage) return forbidden();
    return repo.locked(yearId, async (tx) => {
      const [years, classes, rules, oldClasses, oldRules, models] = await Promise.all([tx.years(), tx.classes(yearId), tx.rules(yearId), tx.classes(fromId), tx.rules(fromId), tx.models()]);
      const year = years.find((y) => y.id === yearId);
      const from = years.find((y) => y.id === fromId);
      if (!year || !from || year.id === from.id) return fail(gradingError("NOT_FOUND", "Ano letivo não encontrado."));
      if (year.status === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
      if (rules.length) return fail(gradingError("INVALID_STATE", "Este ano letivo já tem modelos aplicados."));
      const usable = new Set(models.filter((m) => m.current && !m.archivedAt).map((m) => m.id));
      const count = PERIOD_KINDS[year.periodKind as PeriodKind].count;
      const copied = oldRules.flatMap((r) => {
        if (!usable.has(r.modelId) || (r.period ?? 1) > count || (r.period && year.periodKind !== from.periodKind)) return [];
        if (r.courseId && !classes.some((c) => c.courseId === r.courseId)) return [];
        if (!r.classId) return r.subjectId && !classes.some((c) => c.subjects.some((s) => s.id === r.subjectId)) ? [] : [{ ...r }];
        const old = oldClasses.find((c) => c.id === r.classId);
        const cls = old && classes.find((c) => c.grade === old.grade && c.courseId === old.courseId);
        return !cls || (r.subjectId && !cls.subjects.some((s) => s.id === r.subjectId)) ? [] : [{ ...r, classId: cls.id }];
      });
      const created = await tx.insertRules(yearId, copied, actor.id, this.clock.now(), { from: from.name, fromId });
      return ok({ created, skipped: oldRules.length - created });
    });
  }
}
