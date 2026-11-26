import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { QUALIFICATION_LEVELS, type QualificationLevel } from "../../pedagogy/domain/qualifications";
import { type GradingError, gradingError } from "../domain/model";
import { OUTCOME_LABELS, type Outcome, type Progression, progressionOf, type ProgressionRule, type SubjectFinal } from "../domain/progression";
import { levelOf } from "../domain/rules";
import type { Actor, FrozenResults, PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import type { GradebookViewer } from "./Gradebook";
import { gradeName } from "./GradingModels";

type R<T> = Promise<Result<T, GradingError>>;
type Books = PrismaGradebookRepository;
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);
const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
export const DECISION_LABELS = { PASSED: "Transita", RETAINED: "Não transita" } as const;

/**
 * RESULTADO DO ANO — a partir das notas finais publicadas de cada disciplina e das regras de
 * transição do colégio (por ensino). A direção pode deliberar outro resultado, com o motivo.
 * O resultado calculado fica guardado (grading_year_results) para a renovação o ler.
 */
export class YearResults {
  constructor(private readonly clock: Clock) {}

  private async actor(books: Books, viewer: GradebookViewer): Promise<Actor> {
    return viewer.support ? { id: null, name: "Suporte EduFlow" } : { id: viewer.userId, name: await books.userName(viewer.userId) };
  }
  private async rules(books: Books) {
    return new Map((await books.progressionRules()).map((r) => [r.level, { maxNegatives: r.maxNegatives, coreSubjectIds: r.coreSubjectIds, maxCoreNegatives: r.maxCoreNegatives } as ProgressionRule]));
  }

  // ---------------------------------------------------------------- regras de transição

  /** As regras de cada ensino e as disciplinas que lá se dão (para escolher as nucleares). */
  async progression(books: Books, canManage: boolean) {
    const year = await books.currentYear(today(this.clock.now()));
    const [rules, rows] = await Promise.all([this.rules(books), year ? books.allBooks(year.id) : Promise.resolve([])]);
    const levels = (Object.keys(QUALIFICATION_LEVELS) as QualificationLevel[]).map((key) => {
      const subjects = new Map<string, { id: string; name: string; color: string }>();
      for (const r of rows.filter((x) => levelOf(x.grade) === key)) subjects.set(r.subjectId, { id: r.subjectId, name: r.subjectName, color: r.subjectColor });
      const rule = rules.get(key) ?? null;
      return { key, label: QUALIFICATION_LEVELS[key].label, rule, subjects: [...subjects.values()].sort((a, b) => a.name.localeCompare(b.name, "pt")) };
    });
    return { can: { manage: canManage }, levels };
  }

  async setProgression(books: Books, viewer: GradebookViewer & { canManage: boolean }, level: string, input: { maxNegatives: number | null; coreSubjectIds: string[]; maxCoreNegatives: number | null }): R<{ saved: true; recalculated: number }> {
    if (!viewer.canManage) return fail(gradingError("FORBIDDEN", "Mudar as regras de transição exige a permissão “Configurar os critérios de avaliação”."));
    if (!(level in QUALIFICATION_LEVELS)) return fail(gradingError("INVALID_INPUT", "Ensino desconhecido."));
    const core = [...new Set(input.coreSubjectIds)];
    if (input.maxCoreNegatives !== null && !core.length) return fail(gradingError("INVALID_INPUT", "Escolha as disciplinas nucleares antes de limitar as suas negativas."));
    if (input.maxNegatives !== null && input.maxCoreNegatives !== null && input.maxCoreNegatives > input.maxNegatives) return fail(gradingError("INVALID_INPUT", "As negativas nas nucleares não podem passar do total de negativas admitidas."));
    await books.setProgression(level, { maxNegatives: input.maxNegatives, coreSubjectIds: core, maxCoreNegatives: input.maxCoreNegatives }, viewer.support ? null : viewer.userId, this.clock.now());
    // as regras mudaram: recalcula-se o resultado das turmas com notas finais publicadas (do ano em curso)
    const year = await books.currentYear(today(this.clock.now()));
    let recalculated = 0;
    if (year) for (const g of await books.groupsWithFinals(year.id)) recalculated += await this.recompute(books, g.groupId);
    return ok({ saved: true as const, recalculated });
  }

  // ---------------------------------------------------------------- cálculo

  /** O resultado de cada aluno de uma turma (com as notas finais publicadas e as regras do ensino). */
  private async compute(books: Books, groupId: string) {
    const g = await books.groupHeader(groupId);
    if (!g) return null;
    const [students, subjects, finals, rules, decisions] = await Promise.all([books.students(groupId), books.groupSubjects(groupId), books.groupFinals(groupId), this.rules(books), books.decisions(g.yearId)]);
    const rule = rules.get(levelOf(g.grade)) ?? null;
    const rows = students.map((st) => {
      const per = subjects.map((s) => {
        const fin = finals.find((f) => f.subjectId === s.id);
        const r = fin?.results.students.find((x) => x.id === st.id) ?? null;
        return { subject: s, r };
      });
      const list: SubjectFinal[] = per.map(({ subject, r }) => ({ subjectId: subject.id, name: subject.name, published: !!r, passed: r ? (r.status === "EXEMPT" ? true : r.passed) : null, recoveryOpen: !!r?.recoveryOpen, recoveryMax: r?.recoveryMax ?? null }));
      const progression: Progression = progressionOf(rule, list);
      const decision = decisions.find((d) => d.studentId === st.id) ?? null;
      const effective: Outcome = decision?.outcome ?? progression.outcome;
      return { student: st, per, progression, decision, effective };
    });
    return { g, subjects, rule, rows };
  }

  /** Recalcula e guarda o resultado dos alunos de uma turma (depois de publicar o final, ou de mudar as regras). */
  async recompute(books: Books, groupId: string) {
    const c = await this.compute(books, groupId);
    if (!c) return 0;
    await books.saveYearResults(
      c.g.yearId,
      groupId,
      c.rows.map((r) => ({ studentId: r.student.id, computed: r.progression.outcome, negatives: r.progression.negatives.length, details: { reasons: r.progression.reasons, negatives: r.progression.negatives, recovery: r.progression.recovery } })),
      this.clock.now(),
    );
    return c.rows.length;
  }

  // ---------------------------------------------------------------- consulta e deliberação

  /** Todas as turmas de um ano: quantos alunos transitam, não transitam, em recuperação, por decidir. */
  async overview(books: Books, viewer: GradebookViewer, yearId?: string) {
    const years = await books.years();
    const year = (yearId ? years.find((y) => y.id === yearId) : null) ?? (await books.currentYear(today(this.clock.now()))) ?? years[0] ?? null;
    if (!year) return { years: [], year: null, can: { decide: false }, classes: [] };
    const rows = await books.allBooks(year.id);
    const groups = [...new Map(rows.map((r) => [r.groupId, r])).values()];
    const classes = new Map<string, { id: string; grade: number; level: string; courseId: string | null; courseName: string | null; label: string; groups: { id: string; name: string; students: number; counts: Record<Outcome, number> }[] }>();
    for (const r of groups) {
      const c = await this.compute(books, r.groupId);
      const counts: Record<Outcome, number> = { PASSED: 0, RETAINED: 0, RECOVERY: 0, UNDECIDED: 0 };
      for (const x of c?.rows ?? []) counts[x.effective]++;
      const cls = classes.get(r.classId) ?? { id: r.classId, grade: r.grade, level: levelOf(r.grade), courseId: r.courseId, courseName: r.courseName, label: gradeName(r.grade, r.courseName), groups: [] };
      cls.groups.push({ id: r.groupId, name: r.groupName, students: c?.rows.length ?? 0, counts });
      classes.set(r.classId, cls);
    }
    return { years: years.map((y) => ({ id: y.id, name: y.name, status: y.status })), year: { id: year.id, name: year.name, status: year.status }, can: { decide: !!viewer.canPublish && year.status !== "CLOSED" }, labels: OUTCOME_LABELS, classes: [...classes.values()] };
  }

  /** Uma turma: cada aluno com a nota final de cada disciplina, o resultado calculado e a deliberação. */
  async group(books: Books, viewer: GradebookViewer, groupId: string) {
    const c = await this.compute(books, groupId);
    if (!c) return fail(gradingError("NOT_FOUND", "Turma não encontrada."));
    const status = (await books.years()).find((y) => y.id === c.g.yearId)?.status ?? "ACTIVE";
    return ok({
      can: { decide: !!viewer.canPublish && status !== "CLOSED" },
      year: { id: c.g.yearId, name: c.g.yearName },
      group: { id: groupId, name: c.g.groupName, classLabel: gradeName(c.g.grade, c.g.courseName) },
      rule: c.rule,
      ruleSet: !!c.rule && c.rule.maxNegatives !== null,
      subjects: c.subjects.map((s) => ({ id: s.id, name: s.name, code: s.code, color: s.color, core: !!c.rule?.coreSubjectIds.includes(s.id) })),
      labels: OUTCOME_LABELS,
      students: c.rows.map((r) => ({
        id: r.student.id,
        name: r.student.name,
        number: r.student.number,
        finals: Object.fromEntries(r.per.map(({ subject, r: f }) => [subject.id, f ? { value: f.value, level: f.level, passed: f.status === "EXEMPT" ? true : f.passed, status: f.status, recoveryOpen: !!f.recoveryOpen } : null])),
        computed: r.progression.outcome,
        reasons: r.progression.reasons,
        decision: r.decision ? { outcome: r.decision.outcome, reason: r.decision.reason, by: r.decision.decidedBy, at: r.decision.decidedAt.toISOString() } : null,
        outcome: r.effective,
        label: OUTCOME_LABELS[r.effective],
      })),
    });
  }

  /** A direção delibera outro resultado para um aluno (ou retira a deliberação, voltando ao calculado). */
  async decide(books: Books, viewer: GradebookViewer, input: { groupId: string; studentId: string; outcome: "PASSED" | "RETAINED" | null; reason?: string | null }): R<{ outcome: Outcome }> {
    if (!viewer.canPublish) return fail(gradingError("FORBIDDEN", "Deliberar o resultado do ano exige a permissão “Publicar as classificações”."));
    const c = await this.compute(books, input.groupId);
    if (!c) return fail(gradingError("NOT_FOUND", "Turma não encontrada."));
    const status = (await books.years()).find((y) => y.id === c.g.yearId)?.status;
    if (status === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const row = c.rows.find((r) => r.student.id === input.studentId);
    if (!row) return fail(gradingError("INVALID_INPUT", "Esse aluno não está nesta turma."));
    const reason = clean(input.reason);
    if (input.outcome && (reason.length < 3 || reason.length > 300)) return fail(gradingError("INVALID_INPUT", "Indique o motivo da deliberação (3 a 300 caracteres): fica no histórico."));
    if (!input.outcome && !row.decision) return fail(gradingError("INVALID_STATE", "Este aluno não tem deliberação a retirar."));
    await books.setDecision(c.g.yearId, input.groupId, input.studentId, input.outcome ? { outcome: input.outcome, reason } : null, await this.actor(books, viewer), this.clock.now());
    return ok({ outcome: input.outcome ?? row.progression.outcome });
  }

  /** Para a família: as notas finais publicadas e o resultado (só quando já está decidido). */
  async forFamily(books: Books, studentId: string, groupId: string) {
    const c = await this.compute(books, groupId);
    const r = c?.rows.find((x) => x.student.id === studentId);
    if (!c || !r) return null;
    const known = r.decision || r.progression.outcome !== "UNDECIDED";
    return {
      finals: Object.fromEntries(r.per.map(({ subject, r: f }) => [subject.id, f ? { value: f.value, level: f.level, passed: f.status === "EXEMPT" ? true : f.passed, status: f.status } : null])),
      outcome: known ? { outcome: r.effective, label: OUTCOME_LABELS[r.effective], recovery: r.decision ? [] : r.progression.recovery } : null,
    };
  }
}

export type { FrozenResults };
