import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import { OUTCOME_LABELS, type Outcome } from "../domain/progression";
import { levelOf } from "../domain/rules";
import type { PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import type { GradebookViewer } from "./Gradebook";
import { gradeName } from "./GradingModels";

type Books = PrismaGradebookRepository;
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
/** a partir de quantas negativas um aluno aparece em "alunos a acompanhar" */
export const RISK_NEGATIVES = 2;

interface Acc {
  values: number[];
  positives: number;
  negatives: number;
}
const acc = (): Acc => ({ values: [], positives: 0, negatives: 0 });
const summary = (a: Acc) => ({ graded: a.positives + a.negatives, average: a.values.length ? round1(a.values.reduce((s, v) => s + v, 0) / a.values.length) : null, positives: a.positives, negatives: a.negatives, positiveRate: pct(a.positives, a.positives + a.negatives) });

/**
 * PAINEL DA AVALIAÇÃO — para a pedagogia e a direção: o andamento do fecho do período (em
 * preparação → publicadas), as médias e as positivas por classe e por disciplina (só do que foi
 * publicado), os alunos com mais negativas e, no final do ano, os resultados.
 */
export class GradingDashboard {
  constructor(private readonly clock: Clock) {}

  async view(books: Books, viewer: GradebookViewer, yearId?: string, wanted?: number) {
    const years = await books.years();
    const year = (yearId ? years.find((y) => y.id === yearId) : null) ?? (await books.currentYear(today(this.clock.now()))) ?? years[0] ?? null;
    if (!year) return { years: [], year: null, periods: [], period: 1, progress: null, overall: null, classes: [], subjects: [], risk: [], outcomes: null, riskFrom: RISK_NEGATIVES };
    const periods = await books.periods(year.id);
    const day = today(this.clock.now());
    const period = wanted === 0 ? 0 : wanted && periods.some((p) => p.position === wanted) ? wanted : (periods.find((p) => p.startsOn <= day && day <= p.endsOn)?.position ?? [...periods].reverse().find((p) => p.startsOn <= day)?.position ?? 1);
    const kind = year.periodKind as PeriodKind;
    const [rows, terms, pubs, outcomes] = await Promise.all([books.allBooks(year.id), books.terms(year.id, period), books.yearPublications(year.id, period), books.yearOutcomes(year.id)]);

    // andamento: cada disciplina de cada turma num estado
    const status = (g: string, s: string) => terms.find((t) => t.groupId === g && t.subjectId === s)?.status ?? "DRAFT";
    const progress = { books: rows.length, preparing: 0, submitted: 0, validated: 0, published: 0 };
    for (const r of rows) {
      const st = status(r.groupId, r.subjectId);
      if (st === "SUBMITTED") progress.submitted++;
      else if (st === "VALIDATED") progress.validated++;
      else if (st === "PUBLISHED" || (st === "REOPENED" && pubs.some((p) => p.groupId === r.groupId && p.subjectId === r.subjectId))) progress.published++;
      else progress.preparing++;
    }

    // resultados publicados: por classe, por disciplina e por aluno
    const overall = acc();
    const byClass = new Map<string, { id: string; grade: number; level: string; label: string; groups: Set<string>; students: number; acc: Acc; books: number; published: number }>();
    const bySubject = new Map<string, { id: string; name: string; color: string; acc: Acc }>();
    const byStudent = new Map<string, { id: string; name: string; groupId: string; groupName: string; classLabel: string; negatives: string[] }>();
    for (const r of rows) {
      const c = byClass.get(r.classId) ?? { id: r.classId, grade: r.grade, level: levelOf(r.grade), label: gradeName(r.grade, r.courseName), groups: new Set<string>(), students: 0, acc: acc(), books: 0, published: 0 };
      if (!c.groups.has(r.groupId)) {
        c.groups.add(r.groupId);
        c.students += r.students;
      }
      c.books++;
      byClass.set(r.classId, c);
      const pub = pubs.find((p) => p.groupId === r.groupId && p.subjectId === r.subjectId);
      if (!pub) continue;
      c.published++;
      const s = bySubject.get(r.subjectId) ?? { id: r.subjectId, name: r.subjectName, color: r.subjectColor, acc: acc() };
      bySubject.set(r.subjectId, s);
      for (const st of pub.results.students) {
        if (st.status !== "DONE" || st.passed === null) continue;
        for (const a of [overall, c.acc, s.acc]) {
          if (st.value !== null) a.values.push(st.value);
          if (st.passed) a.positives++;
          else a.negatives++;
        }
        if (!st.passed) {
          const k = byStudent.get(st.id) ?? { id: st.id, name: st.name, groupId: r.groupId, groupName: r.groupName, classLabel: gradeName(r.grade, r.courseName), negatives: [] };
          k.negatives.push(r.subjectName);
          byStudent.set(st.id, k);
        }
      }
    }
    const counts: Record<Outcome, number> = { PASSED: 0, RETAINED: 0, RECOVERY: 0, UNDECIDED: 0 };
    for (const o of outcomes) if (o.outcome in counts) counts[o.outcome as Outcome] += o.count;
    const decided = Object.values(counts).reduce((a, b) => a + b, 0);

    return {
      years: years.map((y) => ({ id: y.id, name: y.name, status: y.status })),
      year: { id: year.id, name: year.name, status: year.status },
      periods: [...periods.map((p) => ({ position: p.position, name: periodName(kind, p.position) })), ...(periods.length ? [{ position: 0, name: "Final do ano" }] : [])],
      period,
      can: { publish: !!viewer.canPublish, validate: !!viewer.canValidate },
      progress,
      overall: summary(overall),
      classes: [...byClass.values()].sort((a, b) => a.grade - b.grade || a.label.localeCompare(b.label, "pt")).map((c) => ({ id: c.id, grade: c.grade, level: c.level, label: c.label, groups: c.groups.size, students: c.students, books: c.books, published: c.published, ...summary(c.acc) })),
      subjects: [...bySubject.values()].map((s) => ({ id: s.id, name: s.name, color: s.color, ...summary(s.acc) })).sort((a, b) => (a.positiveRate ?? 101) - (b.positiveRate ?? 101) || a.name.localeCompare(b.name, "pt")),
      riskFrom: RISK_NEGATIVES,
      risk: [...byStudent.values()]
        .filter((s) => s.negatives.length >= RISK_NEGATIVES)
        .sort((a, b) => b.negatives.length - a.negatives.length || a.name.localeCompare(b.name, "pt"))
        .slice(0, 30)
        .map((s) => ({ ...s, count: s.negatives.length })),
      outcomes: decided ? { counts, labels: OUTCOME_LABELS, total: decided } : null,
    };
  }
}
