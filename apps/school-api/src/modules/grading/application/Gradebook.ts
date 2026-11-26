import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import { fmt, type MarkInput, MARK_STATES, type MarkState, type PeriodOutcome, periodResult } from "../domain/engine";
import { AGGREGATIONS, type Component, type Definition, type GradingError, gradingError, SOURCES, summaryOf } from "../domain/model";
import { levelOf, originOf, resolve } from "../domain/rules";
import type { Actor, AssessmentRow, BookRow, PeriodRow, PrismaGradebookRepository } from "../infrastructure/prisma-gradebook";
import type { PrismaGradingSettingsRepository } from "../infrastructure/prisma-grading-settings";
import { gradeName } from "./GradingModels";

type R<T> = Promise<Result<T, GradingError>>;
type Books = PrismaGradebookRepository;
type Settings = PrismaGradingSettingsRepository;

/** Quem está a ver: a conta, se é suporte e se tem a permissão de consultar a avaliação. */
export interface GradebookViewer {
  userId: string;
  support: boolean;
  /** grading.access: a gestão vê todas as cadernetas (só leitura) */
  canView: boolean;
}
export type BookRole = "TEACHER" | "COORDINATOR" | "STAFF";
export const MAX_MARKS_PER_SAVE = 200;

const bad = (m: string) => fail(gradingError("INVALID_INPUT", m));
const forbidden = () => fail(gradingError("FORBIDDEN", "Esta caderneta não é sua: só o professor da disciplina na turma lança as notas."));
const missing = () => fail(gradingError("NOT_FOUND", "Caderneta não encontrada."));
const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const twoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);
const STATUS_LABEL: Record<PeriodOutcome["status"], string> = { DONE: "Calculada", PENDING: "Pendente", MISSING: "Por fazer", EXEMPT: "Dispensado" };

/**
 * O componente onde uma prova do calendário costuma contar: o que tem o mesmo nome da prova; senão
 * a única "prova trimestral/semestral" do modelo; senão a única "prova do professor". O professor confirma.
 */
export function suggestComponent(d: Definition, season: string): string | null {
  const norm = (s: string) => clean(s).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const name = norm(season);
  const exams = d.components.filter((c) => c.source !== "CONTINUOUS");
  // o mesmo nome, ou um dentro do outro ("1.ª prova do professor" → "Prova do professor")
  const same = exams.find((c) => norm(c.name) === name) ?? exams.find((c) => name.includes(norm(c.name)) || norm(c.name).includes(name));
  if (same) return same.key;
  const term = exams.filter((c) => c.source === "TERM_TEST");
  if (term.length === 1) return term[0].key;
  const teacher = exams.filter((c) => c.source === "TEACHER_TEST");
  if (teacher.length === 1 && !term.length) return teacher[0].key;
  return exams[0]?.key ?? null;
}

interface Model {
  id: string;
  name: string;
  version: number;
  definition: Definition;
  origin: ReturnType<typeof originOf>;
}

/**
 * CADERNETA DIGITAL — o professor cria as avaliações da sua disciplina na turma (sempre num
 * componente do modelo que se aplica a esse período) e lança as notas; o motor oficial calcula
 * a média de cada aluno a cada pedido. O diretor de turma e a gestão (grading.access) consultam.
 * Tudo o que muda fica no histórico (grading_changes, só de acrescentar).
 */
export class Gradebook {
  constructor(private readonly clock: Clock) {}

  // ---------------------------------------------------------------- acesso

  private async role(books: Books, viewer: GradebookViewer, book: BookRow): Promise<BookRole | null> {
    const me = viewer.support ? null : await books.employeeOfUser(viewer.userId);
    if (me && book.teacherId === me.id) return "TEACHER";
    if (me && book.coordinatorId === me.id) return "COORDINATOR";
    return viewer.canView ? "STAFF" : null;
  }
  private async actor(books: Books, viewer: GradebookViewer): Promise<Actor> {
    return viewer.support ? { id: null, name: "Suporte EduFlow" } : { id: viewer.userId, name: await books.userName(viewer.userId) };
  }
  /** O modelo (versão em vigor) que se aplica a esta caderneta num período. */
  private async modelFor(settings: Settings, book: BookRow, period: number): Promise<Model | null> {
    const rule = resolve(await settings.rules(book.yearId), { id: book.classId, grade: book.grade, courseId: book.courseId }, book.subjectId, period);
    if (!rule) return null;
    const m = await settings.model(rule.modelId);
    if (!m?.current || !m.currentVersion) return null;
    return { id: m.id, name: m.name, version: m.currentVersion, definition: m.current, origin: originOf(rule) };
  }
  /** Para escrever: a caderneta é do professor, o ano está aberto e o período existe. */
  private async writable(books: Books, settings: Settings, viewer: GradebookViewer, book: BookRow | null, period: number): R<{ book: BookRow; model: Model; periods: PeriodRow[] }> {
    if (!book) return missing();
    if ((await this.role(books, viewer, book)) !== "TEACHER") return forbidden();
    if (book.yearStatus === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: a caderneta é só de leitura."));
    const periods = await books.periods(book.yearId);
    if (!periods.some((p) => p.position === period)) return fail(gradingError("INVALID_STATE", periods.length ? "Esse período não existe neste ano letivo." : "O ano letivo ainda não tem os períodos definidos (Pedagógico → Ano letivo)."));
    const model = await this.modelFor(settings, book, period);
    if (!model) return fail(gradingError("INVALID_STATE", "Esta disciplina ainda não tem modelo de avaliação para este período: fale com a pedagogia."));
    return ok({ book, model, periods });
  }

  // ---------------------------------------------------------------- listas

  /** As cadernetas do professor (e as das turmas que coordena), no ano em curso. */
  async mine(books: Books, viewer: GradebookViewer) {
    const me = viewer.support ? null : await books.employeeOfUser(viewer.userId);
    if (!me) return fail(gradingError("FORBIDDEN", "A caderneta é dos professores: esta conta não está ligada a um professor."));
    const year = await books.currentYear(today(this.clock.now()));
    const rows = year ? await books.myBooks(me.id, year.id) : [];
    const item = (r: (typeof rows)[number]) => ({
      classId: r.classId,
      grade: r.grade,
      courseName: r.courseName,
      mine: r.mine,
      groupId: r.groupId,
      groupName: r.groupName,
      classLabel: gradeName(r.grade, r.courseName),
      shift: r.shift,
      subject: { id: r.subjectId, name: r.subjectName, code: r.subjectCode, color: r.subjectColor },
      students: r.students,
      assessments: r.assessments,
      teacherName: r.teacherName,
    });
    const coordinated = new Map<string, { groupId: string; groupName: string; classLabel: string; subjects: ReturnType<typeof item>[] }>();
    for (const r of rows.filter((x) => !x.mine)) {
      const g = coordinated.get(r.groupId) ?? { groupId: r.groupId, groupName: r.groupName, classLabel: gradeName(r.grade, r.courseName), subjects: [] };
      g.subjects.push(item(r));
      coordinated.set(r.groupId, g);
    }
    return ok({ year: year && { id: year.id, name: year.name, status: year.status }, books: rows.filter((r) => r.mine).map(item), coordinated: [...coordinated.values()] });
  }

  /** Todas as cadernetas de um ano, para a gestão (classe → turma → disciplina). */
  async overview(books: Books, yearId?: string) {
    const years = await books.years();
    const year = (yearId ? years.find((y) => y.id === yearId) : null) ?? (await books.currentYear(today(this.clock.now()))) ?? years[0] ?? null;
    if (!year) return { years: [], year: null, classes: [] };
    const rows = await books.allBooks(year.id);
    const classes = new Map<string, { id: string; grade: number; level: string; courseId: string | null; courseName: string | null; label: string; groups: Map<string, { id: string; name: string; shift: string; students: number; subjects: unknown[] }> }>();
    for (const r of rows) {
      const c = classes.get(r.classId) ?? { id: r.classId, grade: r.grade, level: levelOf(r.grade), courseId: r.courseId, courseName: r.courseName, label: gradeName(r.grade, r.courseName), groups: new Map() };
      const g = c.groups.get(r.groupId) ?? { id: r.groupId, name: r.groupName, shift: r.shift, students: r.students, subjects: [] };
      g.subjects.push({ id: r.subjectId, name: r.subjectName, code: r.subjectCode, color: r.subjectColor, teacherName: r.teacherName, assessments: r.assessments, marks: r.marks });
      c.groups.set(r.groupId, g);
      classes.set(r.classId, c);
    }
    return {
      years: years.map((y) => ({ id: y.id, name: y.name, status: y.status })),
      year: { id: year.id, name: year.name, status: year.status },
      classes: [...classes.values()].map((c) => ({ ...c, groups: [...c.groups.values()] })),
    };
  }

  // ---------------------------------------------------------------- uma caderneta

  async view(books: Books, settings: Settings, viewer: GradebookViewer, groupId: string, subjectId: string, wanted?: number) {
    const book = await books.book(groupId, subjectId);
    if (!book) return missing();
    const role = await this.role(books, viewer, book);
    if (!role) return fail(gradingError("FORBIDDEN", "Sem acesso a esta caderneta."));
    if (!book.inCurriculum && !book.teacherId) return missing();
    const kind = book.periodKind as PeriodKind;
    const periods = await books.periods(book.yearId);
    const day = today(this.clock.now());
    const position = wanted && periods.some((p) => p.position === wanted) ? wanted : (periods.find((p) => p.startsOn <= day && day <= p.endsOn)?.position ?? [...periods].reverse().find((p) => p.startsOn <= day)?.position ?? periods[0]?.position ?? 1);
    const [model, students, assessments, all, notes, types, exams] = await Promise.all([
      this.modelFor(settings, book, position),
      books.students(groupId),
      books.assessments(groupId, subjectId, position),
      books.assessments(groupId, subjectId, null),
      books.notes(groupId, subjectId, position),
      settings.types(),
      books.calendarExams(book.yearId, groupId, subjectId, position),
    ]);
    const typeNames = new Map(types.map((t) => [t.id, t.name]));
    const marks = await books.marks(assessments.map((a) => a.id));
    const d = model?.definition ?? null;
    const comps = new Map((d?.components ?? []).map((c) => [c.key, c]));
    const noteOf = new Map(notes.map((n) => [n.studentId, n]));

    const rows = students.map((s) => {
      const mine = new Map(marks.filter((m) => m.studentId === s.id).map((m) => [m.assessmentId, m]));
      const note = noteOf.get(s.id) ?? null;
      let result: PeriodOutcome | null = null;
      if (d) {
        const input: MarkInput[] = assessments.map((a) => {
          const m = mine.get(a.id);
          return { component: a.componentKey, typeId: a.typeId, weight: a.weight, outOf: a.outOf, label: a.name, score: m?.score ?? null, state: m?.state ?? "GRADED" };
        });
        result = periodResult(d, { marks: input, level: note?.level ?? null, comment: note?.comment ?? null }, typeNames);
      }
      return {
        id: s.id,
        name: s.name,
        number: s.number,
        marks: Object.fromEntries([...mine.values()].map((m) => [m.assessmentId, { state: m.state, score: m.score, note: m.note }])),
        note: note ? { level: note.level, comment: note.comment } : null,
        result,
      };
    });
    // com média (ou, nos qualitativos, com menção); a média da turma só com números
    const done = rows.filter((r) => r.result?.status === "DONE");
    const valued = done.filter((r) => r.result!.value !== null);
    const can = role === "TEACHER" && book.yearStatus !== "CLOSED" && !!model;
    return ok({
      role,
      can: { edit: can },
      year: { id: book.yearId, name: book.yearName, status: book.yearStatus, periodKind: kind },
      group: { id: book.groupId, name: book.groupName, classLabel: gradeName(book.grade, book.courseName), shift: book.shift },
      subject: { id: book.subjectId, name: book.subjectName, code: book.subjectCode, color: book.subjectColor },
      teacher: book.teacherName,
      periods: periods.map((p) => ({ position: p.position, name: periodName(kind, p.position), startsOn: p.startsOn, endsOn: p.endsOn, assessments: all.filter((a) => a.period === p.position).length })),
      period: position,
      model: model && {
        id: model.id,
        name: model.name,
        version: model.version,
        origin: model.origin,
        summary: summaryOf(model.definition),
        kind: model.definition.kind,
        scale: model.definition.scale,
        levels: model.definition.levels.map((l) => ({ key: l.key, label: l.label, from: l.from, positive: l.positive })),
        descriptive: model.definition.descriptive,
        weighting: model.definition.weighting,
        decimals: model.definition.decimals,
        components: model.definition.components.map((c) => ({
          key: c.key,
          name: c.name,
          source: c.source,
          sourceLabel: SOURCES[c.source].label,
          weight: c.weight,
          aggregation: c.aggregation,
          aggregationLabel: AGGREGATIONS[c.aggregation].label,
          minItems: c.minItems,
          maxItems: c.maxItems,
          parts: c.parts.map((p) => ({ typeId: p.typeId, name: typeNames.get(p.typeId) ?? "—", weight: p.weight })),
          count: assessments.filter((a) => a.componentKey === c.key).length,
        })),
      },
      issue: !periods.length ? "O ano letivo ainda não tem os períodos definidos (Pedagógico → Ano letivo)." : !model ? "Esta disciplina ainda não tem modelo de avaliação neste período: fale com a pedagogia." : null,
      types: types.filter((t) => !t.archived).map((t) => ({ id: t.id, name: t.name })),
      states: Object.entries(MARK_STATES).map(([value, label]) => ({ value, label })),
      assessments: assessments.map((a) => ({
        id: a.id,
        componentKey: a.componentKey,
        inModel: comps.has(a.componentKey),
        typeId: a.typeId,
        typeName: a.typeName,
        name: a.name,
        heldOn: a.heldOn,
        outOf: a.outOf,
        weight: a.weight,
        revision: a.revision,
        marks: a.marks,
        createdBy: a.createdByName,
        exam: a.examId ? { id: a.examId, day: a.examDay, cancelled: a.examStatus === "CANCELLED", season: a.seasonName, open: !!a.examDay && a.examDay <= day } : null,
      })),
      /** as provas do calendário publicado desta turma e disciplina, no período */
      exams: exams.map((e) => ({
        id: e.id,
        season: e.seasonName,
        day: e.day,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        room: e.room,
        cancelled: e.status === "CANCELLED",
        cancelReason: e.cancelReason,
        assessmentId: e.assessmentId,
        suggested: d ? suggestComponent(d, e.seasonName) : null,
      })),
      students: rows,
      stats: {
        students: rows.length,
        done: done.length,
        pending: rows.filter((r) => r.result?.status === "PENDING").length,
        missing: rows.filter((r) => r.result?.status === "MISSING").length,
        passed: done.filter((r) => r.result!.passed).length,
        average: valued.length ? Math.round((valued.reduce((s, r) => s + r.result!.value!, 0) / valued.length) * 100) / 100 : null,
        statusLabels: STATUS_LABEL,
      },
    });
  }

  async history(books: Books, viewer: GradebookViewer, groupId: string, subjectId: string, period: number) {
    const book = await books.book(groupId, subjectId);
    if (!book) return missing();
    if (!(await this.role(books, viewer, book))) return fail(gradingError("FORBIDDEN", "Sem acesso a esta caderneta."));
    const [rows, assessments] = await Promise.all([books.history(groupId, subjectId, period), books.assessments(groupId, subjectId, period)]);
    const names = new Map(assessments.map((a) => [a.id, a.name]));
    const mark = (x: Record<string, unknown> | null) => (!x ? "por lançar" : x.state === "GRADED" ? fmt(Number(x.score)) : (MARK_STATES[x.state as MarkState] ?? String(x.state)).toLowerCase());
    return ok({
      changes: rows.map((h) => {
        const what = h.assessmentId ? (names.get(h.assessmentId) ?? (h.before?.name as string | undefined) ?? (h.after?.name as string | undefined) ?? "avaliação") : null;
        const text =
          h.kind === "ASSESSMENT_CREATED"
            ? `Criou “${String(h.after?.name ?? what)}”`
            : h.kind === "ASSESSMENT_UPDATED"
              ? `Alterou “${String(h.after?.name ?? what)}”`
              : h.kind === "ASSESSMENT_DELETED"
                ? `Apagou “${String(h.before?.name ?? what)}”${Array.isArray(h.before?.marks) && (h.before.marks as unknown[]).length ? ` (com ${(h.before.marks as unknown[]).length === 1 ? "1 nota" : `${(h.before.marks as unknown[]).length} notas`})` : ""}`
                : h.kind === "MARK"
                  ? `${h.studentName ?? "Aluno"} · ${what}: ${mark(h.before)} → ${mark(h.after)}`
                  : `${h.studentName ?? "Aluno"} · menção ou apreciação alterada`;
        return { at: h.at.toISOString(), by: h.byName, text, reason: h.reason };
      }),
    });
  }

  // ---------------------------------------------------------------- avaliações

  private checkAssessment(d: Definition, c: Component, input: { typeId: string | null; name: string; heldOn: string | null; outOf: number | null; weight: number | null }, types: Set<string>, year: { startsOn: string; endsOn: string } | null) {
    const name = clean(input.name);
    if (name.length < 2 || name.length > 80) return bad("O nome da avaliação tem 2 a 80 caracteres (ex.: Teste 1, Trabalho de grupo).");
    if (c.aggregation === "BY_TYPE" && !c.parts.some((p) => p.typeId === input.typeId)) return bad(`Em “${c.name}”, escolha o elemento de avaliação (${c.parts.length} possíveis).`);
    if (input.typeId && !types.has(input.typeId)) return bad("Esse elemento de avaliação não existe (ou está arquivado).");
    if (input.outOf !== null && (input.outOf <= 0 || input.outOf > 1000 || !twoDecimals(input.outOf))) return bad("A cotação vai até 1000, com até duas casas decimais.");
    if (input.weight !== null && c.aggregation !== "WEIGHTED") return bad(`Em “${c.name}” as avaliações não têm peso próprio (${AGGREGATIONS[c.aggregation].label.toLowerCase()}).`);
    if (input.weight !== null && (input.weight <= 0 || input.weight > 100 || !twoDecimals(input.weight))) return bad("O peso da avaliação vai de 0,01 a 100.");
    if (input.heldOn && year && (input.heldOn < year.startsOn || input.heldOn > year.endsOn)) return bad("A data tem de ser dentro do ano letivo.");
    if (d.kind === "QUALITATIVE") return bad("Este modelo é só qualitativo: não leva avaliações com nota, só a menção de cada aluno.");
    return ok({ ...input, name });
  }

  /**
   * Cria uma avaliação. Com `examId`, regista uma prova do calendário publicado desta turma e
   * disciplina, no mesmo período: o nome (por omissão) e a data vêm da prova.
   */
  async createAssessment(books: Books, settings: Settings, viewer: GradebookViewer, groupId: string, subjectId: string, input: { period: number; componentKey: string; typeId?: string | null; name: string; heldOn?: string | null; outOf?: number | null; weight?: number | null; examId?: string | null }): R<{ id: string }> {
    const w = await this.writable(books, settings, viewer, await books.book(groupId, subjectId), input.period);
    if (!w.ok) return w;
    const { book, model, periods } = w.value;
    const c = model.definition.components.find((x) => x.key === input.componentKey);
    if (!c) return bad("Esse componente não faz parte do modelo de avaliação desta disciplina.");
    let name = input.name;
    let heldOn = input.heldOn ?? null;
    const examId = input.examId ?? null;
    if (examId) {
      const e = await books.calendarExam(examId);
      if (!e || e.groupId !== groupId || e.subjectId !== subjectId || e.yearId !== book.yearId) return bad("Essa prova não é desta turma e disciplina.");
      if (e.period !== input.period) return bad("Essa prova é de outro período.");
      if (e.seasonStatus !== "PUBLISHED") return fail(gradingError("INVALID_STATE", "O calendário dessa prova ainda não foi publicado."));
      if (e.status === "CANCELLED") return fail(gradingError("INVALID_STATE", "Essa prova foi cancelada."));
      if (e.assessmentId) return fail(gradingError("INVALID_STATE", "Essa prova já está registada na caderneta."));
      if (c.source === "CONTINUOUS") return bad(`Uma prova do calendário não conta na “${c.name}”: escolha o componente das provas.`);
      if (!clean(name)) name = e.seasonName;
      heldOn = e.day;
    }
    const types = new Set((await settings.types()).filter((t) => !t.archived).map((t) => t.id));
    const span = periods.length ? { startsOn: periods[0].startsOn, endsOn: periods[periods.length - 1].endsOn } : null;
    const checked = this.checkAssessment(model.definition, c, { typeId: input.typeId ?? null, name, heldOn, outOf: input.outOf ?? null, weight: input.weight ?? null }, types, span);
    if (!checked.ok) return checked;
    const actor = await this.actor(books, viewer);
    return books.locked(groupId, subjectId, async (tx) => {
      if (c.maxItems !== null && (await tx.countIn(groupId, subjectId, input.period, c.key)) >= c.maxItems)
        return fail(gradingError("INVALID_STATE", `“${c.name}” admite no máximo ${c.maxItems} ${c.maxItems === 1 ? "avaliação" : "avaliações"} por período.`));
      if (examId && (await tx.calendarExam(examId))?.assessmentId) return fail(gradingError("INVALID_STATE", "Essa prova já está registada na caderneta."));
      const id = await tx.createAssessment({ yearId: book.yearId, groupId, subjectId }, { period: input.period, componentKey: c.key, ...checked.value, examId }, actor, this.clock.now());
      return ok({ id });
    });
  }

  private async ownAssessment(books: Books, settings: Settings, viewer: GradebookViewer, id: string): R<{ a: AssessmentRow; book: BookRow; model: Model; periods: PeriodRow[]; c: Component | null }> {
    const a = await books.assessment(id);
    if (!a) return fail(gradingError("NOT_FOUND", "Avaliação não encontrada."));
    const w = await this.writable(books, settings, viewer, await books.book(a.groupId, a.subjectId), a.period);
    if (!w.ok) return w;
    return ok({ a, ...w.value, c: w.value.model.definition.components.find((x) => x.key === a.componentKey) ?? null });
  }

  async updateAssessment(books: Books, settings: Settings, viewer: GradebookViewer, id: string, input: { revision: number; typeId?: string | null; name: string; heldOn?: string | null; outOf?: number | null; weight?: number | null }): R<{ saved: true }> {
    const o = await this.ownAssessment(books, settings, viewer, id);
    if (!o.ok) return o;
    const { a, model, periods, c } = o.value;
    if (!c) return fail(gradingError("INVALID_STATE", "Esta avaliação é de um componente que já não está no modelo: não conta para a média e só se pode apagar."));
    const types = new Set((await settings.types()).filter((t) => !t.archived || t.id === a.typeId).map((t) => t.id));
    const span = periods.length ? { startsOn: periods[0].startsOn, endsOn: periods[periods.length - 1].endsOn } : null;
    // a data de uma prova do calendário é a da prova
    const checked = this.checkAssessment(model.definition, c, { typeId: input.typeId ?? null, name: input.name, heldOn: a.examId ? a.examDay : (input.heldOn ?? null), outOf: input.outOf ?? null, weight: input.weight ?? null }, types, span);
    if (!checked.ok) return checked;
    const actor = await this.actor(books, viewer);
    return books.locked(a.groupId, a.subjectId, async (tx) => {
      // as notas já lançadas têm de caber na cotação nova
      const top = checked.value.outOf ?? model.definition.scale.max;
      const over = (await tx.marks([a.id])).filter((m) => m.score !== null && m.score > top).length;
      if (over) return bad(`Há ${over} ${over === 1 ? "nota acima" : "notas acima"} de ${fmt(top)}: corrija-as antes de mudar a cotação.`);
      return (await tx.updateAssessment(a, input.revision, checked.value, actor, this.clock.now())) ? ok({ saved: true as const }) : fail(gradingError("CHANGED", "Esta avaliação foi alterada entretanto. Atualize a página."));
    });
  }

  async deleteAssessment(books: Books, settings: Settings, viewer: GradebookViewer, id: string, confirm: boolean): R<{ deleted: true }> {
    const a = await books.assessment(id);
    if (!a) return fail(gradingError("NOT_FOUND", "Avaliação não encontrada."));
    const book = await books.book(a.groupId, a.subjectId);
    if (!book) return missing();
    if ((await this.role(books, viewer, book)) !== "TEACHER") return forbidden();
    if (book.yearStatus === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: a caderneta é só de leitura."));
    if (a.marks > 0 && !confirm) return fail(gradingError("NEEDS_CONFIRMATION", `Esta avaliação já tem ${a.marks} ${a.marks === 1 ? "nota lançada" : "notas lançadas"}: ao apagá-la, deixam de contar para a média (ficam no histórico).`));
    const actor = await this.actor(books, viewer);
    await books.locked(a.groupId, a.subjectId, (tx) => tx.deleteAssessment(a, actor, this.clock.now()));
    return ok({ deleted: true as const });
  }

  // ---------------------------------------------------------------- notas

  async setMarks(books: Books, settings: Settings, viewer: GradebookViewer, id: string, input: { marks: { studentId: string; state: MarkState | null; score?: number | null; note?: string | null }[]; reason?: string | null }): R<{ changed: number }> {
    const o = await this.ownAssessment(books, settings, viewer, id);
    if (!o.ok) return o;
    const { a, model, c } = o.value;
    if (!c) return fail(gradingError("INVALID_STATE", "Esta avaliação é de um componente que já não está no modelo: não conta para a média e só se pode apagar."));
    if (input.marks.length > MAX_MARKS_PER_SAVE) return bad(`No máximo ${MAX_MARKS_PER_SAVE} notas de cada vez.`);
    // uma prova do calendário: as notas lançam-se a partir do dia da prova; cancelada, só se retiram
    if (a.examId && input.marks.some((m) => m.state !== null)) {
      if (a.examStatus === "CANCELLED") return fail(gradingError("INVALID_STATE", "Esta prova foi cancelada no calendário: não leva notas (pode apagar a avaliação)."));
      if (a.examDay && a.examDay > today(this.clock.now())) return fail(gradingError("INVALID_STATE", `A prova é a ${a.examDay.split("-").reverse().join("/")}: as notas lançam-se a partir desse dia.`));
    }
    const students = new Set((await books.students(a.groupId)).map((s) => s.id));
    const { min, max } = model.definition.scale;
    const seen = new Set<string>();
    const entries: { studentId: string; state: MarkState | null; score: number | null; note: string | null }[] = [];
    for (const m of input.marks) {
      if (!students.has(m.studentId)) return bad("Há um aluno que não está nesta turma.");
      if (seen.has(m.studentId)) return bad("Há um aluno repetido.");
      seen.add(m.studentId);
      const note = clean(m.note) || null;
      if (note && note.length > 200) return bad("A observação de uma nota tem no máximo 200 caracteres.");
      if (m.state === null) {
        entries.push({ studentId: m.studentId, state: null, score: null, note: null });
        continue;
      }
      if (m.state !== "GRADED") {
        entries.push({ studentId: m.studentId, state: m.state, score: null, note });
        continue;
      }
      const s = m.score ?? null;
      if (s === null || !Number.isFinite(s) || !twoDecimals(s)) return bad("Cada nota leva um número, com até duas casas decimais.");
      if (a.outOf !== null ? s < 0 || s > a.outOf : s < min || s > max) return bad(a.outOf !== null ? `As notas desta avaliação vão de 0 a ${fmt(a.outOf)} (a cotação).` : `As notas vão de ${fmt(min)} a ${fmt(max)}.`);
      entries.push({ studentId: m.studentId, state: "GRADED", score: s, note });
    }
    const reason = clean(input.reason) || null;
    if (reason && reason.length > 300) return bad("O motivo tem no máximo 300 caracteres.");
    const actor = await this.actor(books, viewer);
    const changed = await books.locked(a.groupId, a.subjectId, async (tx) => {
      if (!(await tx.assessment(a.id))) return null;
      return tx.setMarks(a, entries, reason, actor, this.clock.now());
    });
    return changed === null ? fail(gradingError("NOT_FOUND", "Esta avaliação foi apagada entretanto.")) : ok({ changed });
  }

  /** Menção do período (modelos qualitativos) e apreciação escrita de cada aluno. */
  async setNotes(books: Books, settings: Settings, viewer: GradebookViewer, groupId: string, subjectId: string, input: { period: number; notes: { studentId: string; level?: string | null; comment?: string | null }[] }): R<{ changed: number }> {
    const w = await this.writable(books, settings, viewer, await books.book(groupId, subjectId), input.period);
    if (!w.ok) return w;
    const { book, model } = w.value;
    const d = model.definition;
    if (d.kind === "NUMERIC") return bad("Este modelo é só quantitativo: a menção sai da nota e não há apreciação escrita.");
    if (input.notes.length > MAX_MARKS_PER_SAVE) return bad(`No máximo ${MAX_MARKS_PER_SAVE} alunos de cada vez.`);
    const students = new Set((await books.students(groupId)).map((s) => s.id));
    const entries: { studentId: string; level: string | null; comment: string | null }[] = [];
    for (const n of input.notes) {
      if (!students.has(n.studentId)) return bad("Há um aluno que não está nesta turma.");
      const level = n.level || null;
      if (level && (d.kind !== "QUALITATIVE" || !d.levels.some((l) => l.key === level))) return bad(d.kind === "QUALITATIVE" ? "Menção desconhecida." : "Neste modelo a menção sai da nota.");
      const comment = clean(n.comment) || null;
      if (comment && d.descriptive === "NONE") return bad("Este modelo não tem apreciação escrita.");
      if (comment && comment.length > 1000) return bad("A apreciação tem no máximo 1000 caracteres.");
      entries.push({ studentId: n.studentId, level, comment });
    }
    const actor = await this.actor(books, viewer);
    const changed = await books.locked(groupId, subjectId, (tx) => tx.setNotes({ yearId: book.yearId, groupId, subjectId, period: input.period }, entries, actor, this.clock.now()));
    return ok({ changed });
  }
}
