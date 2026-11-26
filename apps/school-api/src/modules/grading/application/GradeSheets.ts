import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import { fmt } from "../domain/engine";
import { type GradingError, gradingError } from "../domain/model";
import { levelOf } from "../domain/rules";
import type { PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import { type XlsxCell, xlsx } from "../infrastructure/xlsx";
import type { GradebookViewer } from "./Gradebook";
import { gradeName } from "./GradingModels";
import { YearResults } from "./YearResults";

type R<T> = Promise<Result<T, GradingError>>;
type Books = PrismaGradebookRepository;
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);
const SHIFTS: Record<string, string> = { MANHA: "Manhã", TARDE: "Tarde", NOITE: "Noite" };
const when = new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Luanda" });

export interface SheetCell {
  text: string;
  value: number | null;
  passed: boolean | null;
  status: string;
}
export interface Sheet {
  school: string;
  title: string;
  year: { id: string; name: string };
  group: { id: string; name: string; classLabel: string; shift: string | null; room: string | null; coordinator: string | null };
  period: { position: number; name: string };
  final: boolean;
  subjects: { id: string; name: string; code: string; color: string; teacher: string | null; published: boolean; publishedAt: string | null; rectified: boolean }[];
  students: { id: string; order: number; number: number | null; name: string; cells: Record<string, SheetCell | null>; negatives: number; average: number | null; outcome: { key: string; label: string } | null }[];
  stats: { id: string; average: number | null; positives: number; negatives: number; graded: number }[];
  /** todas as disciplinas publicadas? (senão a pauta é provisória) */
  complete: boolean;
  missing: string[];
  generatedAt: string;
  generatedAtLabel: string;
}

/**
 * PAUTAS — a pauta de uma turma num período (ou do final do ano, com o resultado): só com o que a
 * direção publicou (a última publicação de cada disciplina). O que está por publicar fica em branco
 * e a pauta diz que é provisória. Sai em A4 (impressão / PDF, no portal) e em .xlsx (daqui).
 */
export class GradeSheets {
  constructor(private readonly clock: Clock) {}

  /** As turmas de um ano e, por período, quantas disciplinas já estão publicadas. */
  async overview(books: Books, yearId?: string) {
    const years = await books.years();
    const year = (yearId ? years.find((y) => y.id === yearId) : null) ?? (await books.currentYear(today(this.clock.now()))) ?? years[0] ?? null;
    if (!year) return { years: [], year: null, periods: [], classes: [] };
    const [periods, rows, counts] = await Promise.all([books.periods(year.id), books.allBooks(year.id), books.publishedCounts(year.id)]);
    const kind = year.periodKind as PeriodKind;
    const classes = new Map<string, { id: string; grade: number; level: string; courseId: string | null; courseName: string | null; label: string; groups: { id: string; name: string; students: number; subjects: number; published: Record<string, number> }[] }>();
    for (const r of rows) {
      const cls = classes.get(r.classId) ?? { id: r.classId, grade: r.grade, level: levelOf(r.grade), courseId: r.courseId, courseName: r.courseName, label: gradeName(r.grade, r.courseName), groups: [] };
      let g = cls.groups.find((x) => x.id === r.groupId);
      if (!g) {
        g = { id: r.groupId, name: r.groupName, students: r.students, subjects: 0, published: Object.fromEntries(counts.filter((c) => c.groupId === r.groupId).map((c) => [String(c.period), c.subjects])) };
        cls.groups.push(g);
      }
      g.subjects++;
      classes.set(r.classId, cls);
    }
    return {
      years: years.map((y) => ({ id: y.id, name: y.name, status: y.status })),
      year: { id: year.id, name: year.name, status: year.status },
      periods: [...periods.map((p) => ({ position: p.position, name: periodName(kind, p.position) })), { position: 0, name: "Final do ano" }],
      classes: [...classes.values()],
    };
  }

  /** A pauta de uma turma num período (0 = final do ano). */
  async sheet(books: Books, viewer: GradebookViewer, school: string, groupId: string, period: number): R<Sheet> {
    const g = await books.groupHeader(groupId);
    if (!g) return fail(gradingError("NOT_FOUND", "Turma não encontrada."));
    const kind = g.periodKind as PeriodKind;
    const periods = await books.periods(g.yearId);
    if (period !== 0 && !periods.some((p) => p.position === period)) return fail(gradingError("INVALID_INPUT", "Esse período não existe neste ano letivo."));
    const [subjects, students, pubs, extra, rows] = await Promise.all([books.groupSubjects(groupId), books.students(groupId), books.groupPublications(groupId, period), books.groupExtra(groupId), books.allBooks(g.yearId)]);
    const outcomes = period === 0 ? await new YearResults(this.clock).group(books, viewer, groupId) : null;
    const teacher = (subjectId: string) => rows.find((r) => r.groupId === groupId && r.subjectId === subjectId)?.teacherName ?? null;
    const pname = period === 0 ? "Final do ano" : periodName(kind, period);
    const now = this.clock.now();

    const list = students.map((st, i) => {
      const cells: Record<string, SheetCell | null> = {};
      for (const s of subjects) {
        const r = pubs.find((p) => p.subjectId === s.id)?.results.students.find((x) => x.id === st.id) ?? null;
        cells[s.id] = !r ? null : { text: r.status === "EXEMPT" ? "Disp." : r.value !== null ? fmt(r.value) : (r.level ?? "—"), value: r.status === "EXEMPT" ? null : r.value, passed: r.status === "EXEMPT" ? null : r.passed, status: r.status };
      }
      const valued = Object.values(cells).filter((c): c is SheetCell => !!c && c.value !== null);
      const o = outcomes?.ok ? outcomes.value.students.find((x) => x.id === st.id) : null;
      return {
        id: st.id,
        order: i + 1,
        number: st.number,
        name: st.name,
        cells,
        negatives: Object.values(cells).filter((c) => c?.passed === false).length,
        average: valued.length ? Math.round((valued.reduce((a, c) => a + c.value!, 0) / valued.length) * 10) / 10 : null,
        outcome: o ? { key: o.outcome, label: o.label } : null,
      };
    });
    const stats = subjects.map((s) => {
      const cs = list.map((x) => x.cells[s.id]).filter((c): c is SheetCell => !!c);
      const v = cs.filter((c) => c.value !== null);
      return { id: s.id, average: v.length ? Math.round((v.reduce((a, c) => a + c.value!, 0) / v.length) * 10) / 10 : null, positives: cs.filter((c) => c.passed === true).length, negatives: cs.filter((c) => c.passed === false).length, graded: cs.length };
    });
    const missing = subjects.filter((s) => !pubs.some((p) => p.subjectId === s.id)).map((s) => s.name);
    const classLabel = gradeName(g.grade, g.courseName);
    return ok({
      school,
      title: period === 0 ? "Pauta final" : `Pauta do ${pname}`,
      year: { id: g.yearId, name: g.yearName },
      group: { id: groupId, name: g.groupName, classLabel, shift: extra.shift ? (SHIFTS[extra.shift] ?? extra.shift) : null, room: extra.room, coordinator: extra.coordinator },
      period: { position: period, name: pname },
      final: period === 0,
      subjects: subjects.map((s) => {
        const p = pubs.find((x) => x.subjectId === s.id);
        return { id: s.id, name: s.name, code: s.code, color: s.color, teacher: teacher(s.id), published: !!p, publishedAt: p?.publishedAt.toISOString() ?? null, rectified: (p?.number ?? 0) > 1 };
      }),
      students: list,
      stats,
      complete: !missing.length && subjects.length > 0,
      missing,
      generatedAt: now.toISOString(),
      generatedAtLabel: when.format(now),
    });
  }

  /** A mesma pauta em .xlsx (números como números; negativas a vermelho). */
  async workbook(books: Books, viewer: GradebookViewer, school: string, groupId: string, period: number): R<{ fileName: string; mimeType: string; content: Buffer }> {
    const r = await this.sheet(books, viewer, school, groupId, period);
    if (!r.ok) return r;
    const s = r.value;
    const width = 2 + s.subjects.length + 2 + (s.final ? 1 : 0);
    const head: XlsxCell[] = ["N.º", "Aluno", ...s.subjects.map((x) => x.code || x.name), "Negativas", "Média", ...(s.final ? ["Resultado"] : [])].map((v) => ({ v, bold: true }));
    const rows: XlsxCell[][] = [
      [{ v: s.school, bold: true }],
      [{ v: `${s.title} · ${s.year.name}`, bold: true }],
      [`${s.group.classLabel} · Turma ${s.group.name}${s.group.shift ? ` · ${s.group.shift}` : ""}${s.group.coordinator ? ` · Diretor(a) de turma: ${s.group.coordinator}` : ""}`],
      [s.complete ? "Classificações publicadas." : `Provisória: falta publicar ${s.missing.join(", ")}.`],
      [],
      head,
      ...s.students.map((st) => [
        st.order,
        st.name,
        ...s.subjects.map((x): XlsxCell => {
          const c = st.cells[x.id];
          return !c ? null : { v: c.value ?? c.text, red: c.passed === false };
        }),
        st.negatives,
        st.average,
        ...(s.final ? [st.outcome?.label ?? ""] : []),
      ]),
      [],
      [{ v: "Média", bold: true }, null, ...s.stats.map((x) => x.average)],
      [{ v: "Positivas", bold: true }, null, ...s.stats.map((x) => x.positives)],
      [{ v: "Negativas", bold: true }, null, ...s.stats.map((x) => x.negatives)],
      [],
      ["Disciplinas:"],
      ...s.subjects.map((x) => [x.code || "", `${x.name}${x.teacher ? ` · ${x.teacher}` : ""}${x.published ? "" : " · por publicar"}${x.rectified ? " · retificada" : ""}`]),
      [],
      [`Gerado pelo EduFlow em ${s.generatedAtLabel}.`],
    ];
    const content = xlsx({ name: s.period.name, widths: [6, 34, ...s.subjects.map(() => 9), 10, 8, ...(s.final ? [16] : [])].slice(0, width), rows, freeze: { rows: 6, cols: 2 } });
    const slug = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    return ok({ fileName: `pauta-${slug(s.group.classLabel)}-${slug(s.group.name)}-${slug(s.period.name)}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content });
  }
}
