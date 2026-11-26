import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { periodName, type PeriodKind } from "../../pedagogy/domain/calendar";
import { fmt, type MarkInput, MARK_STATES, type MarkState, type PeriodOutcome, periodResult, type YearOutcome, yearResult } from "../domain/engine";
import { AGGREGATIONS, type Component, type Definition, type GradingError, gradingError, SOURCES, summaryOf } from "../domain/model";
import { levelOf, originOf, resolve } from "../domain/rules";
import type { Actor, AssessmentRow, BookRow, FrozenResults, PeriodRow, PrismaGradebookRepository, TermRow, TermStatus } from "../infrastructure/prisma-gradebook";
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
  /** grading.results.validate · publish · rectify */
  canValidate?: boolean;
  canPublish?: boolean;
  canRectify?: boolean;
}
/** O nome de um período; a posição 0 é o "Final do ano" (nota final, exame e recuperação). */
export const termName = (kind: PeriodKind, position: number) => (position === 0 ? "Final do ano" : periodName(kind, position));
/** Em que estados o professor pode alterar a caderneta (sem linha = em preparação). */
const EDITABLE: (TermStatus | null)[] = [null, "RETURNED", "REOPENED"];
export const TERM_LABELS: Record<TermStatus | "DRAFT", string> = { DRAFT: "Em preparação", RETURNED: "Devolvida", SUBMITTED: "Pendente de validação", VALIDATED: "Validada", PUBLISHED: "Publicada", REOPENED: "Em retificação" };
const termLabel = (t: { status: TermStatus; publications: number } | null) => (!t ? TERM_LABELS.DRAFT : t.status === "PUBLISHED" && t.publications > 1 ? "Retificada" : TERM_LABELS[t.status]);
const LOCKED: Record<string, string> = {
  SUBMITTED: "As classificações deste período foram submetidas e aguardam validação: já não se alteram. Se precisar de corrigir, peça que lhas devolvam.",
  VALIDATED: "As classificações deste período já foram validadas: já não se alteram.",
  PUBLISHED: "As classificações deste período estão publicadas: só se alteram numa retificação aberta pela direção.",
};
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
  /**
   * O modelo que se aplica a esta caderneta num período: a versão em vigor; mas, depois de o período
   * ter sido publicado, a versão com que foi calculado (uma versão nova não mexe no que já se publicou).
   */
  private async modelFor(settings: Settings, book: BookRow, period: number, term: TermRow | null = null): Promise<Model | null> {
    const rule = resolve(await settings.rules(book.yearId), { id: book.classId, grade: book.grade, courseId: book.courseId }, book.subjectId, period);
    if (term && term.publications > 0 && term.modelId && term.modelVersion) {
      const [m, v] = await Promise.all([settings.model(term.modelId), settings.versions(term.modelId)]);
      const frozen = v.find((x) => x.number === term.modelVersion);
      if (m && frozen) return { id: m.id, name: m.name, version: frozen.number, definition: frozen.definition, origin: rule ? originOf(rule) : "SCHOOL" };
    }
    if (!rule) return null;
    const m = await settings.model(rule.modelId);
    if (!m?.current || !m.currentVersion) return null;
    return { id: m.id, name: m.name, version: m.currentVersion, definition: m.current, origin: originOf(rule) };
  }
  /** Para escrever: a caderneta é do professor, o ano está aberto, o período existe e ainda não foi submetido. */
  private async writable(books: Books, settings: Settings, viewer: GradebookViewer, book: BookRow | null, period: number): R<{ book: BookRow; model: Model; periods: PeriodRow[]; term: TermRow | null }> {
    if (!book) return missing();
    if ((await this.role(books, viewer, book)) !== "TEACHER") return forbidden();
    if (book.yearStatus === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: a caderneta é só de leitura."));
    const periods = await books.periods(book.yearId);
    if (period !== 0 && !periods.some((p) => p.position === period)) return fail(gradingError("INVALID_STATE", periods.length ? "Esse período não existe neste ano letivo." : "O ano letivo ainda não tem os períodos definidos (Pedagógico → Ano letivo)."));
    const term = await books.term(book.groupId, book.subjectId, period);
    if (!EDITABLE.includes(term?.status ?? null)) return fail(gradingError("INVALID_STATE", LOCKED[term!.status]));
    if (period === 0) {
      // o final do ano só depois de publicados todos os períodos
      const published = new Set((await books.latestPublications(book.groupId, book.subjectId)).map((p) => p.period));
      const missing = periods.filter((p) => !published.has(p.position));
      if (!periods.length || missing.length) return fail(gradingError("INVALID_STATE", `O final do ano só se lança depois de publicadas as classificações de todos os períodos${missing.length ? ` (falta: ${missing.map((p) => periodName(book.periodKind as PeriodKind, p.position)).join(", ")})` : ""}.`));
    }
    const model = period === 0 ? await this.yearModel(books, settings, book, periods) : await this.modelFor(settings, book, period, term);
    if (!model) return fail(gradingError("INVALID_STATE", "Esta disciplina ainda não tem modelo de avaliação para este período: fale com a pedagogia."));
    return ok({ book, model, periods, term });
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

  /** Uma caderneta num período; com `wanted` = 0, o "Final do ano" (a mesma forma, mais `final`). */
  async view(books: Books, settings: Settings, viewer: GradebookViewer, groupId: string, subjectId: string, wanted?: number): R<Record<string, unknown>> {
    const book = await books.book(groupId, subjectId);
    if (!book) return missing();
    const role = await this.role(books, viewer, book);
    if (!role) return fail(gradingError("FORBIDDEN", "Sem acesso a esta caderneta."));
    if (!book.inCurriculum && !book.teacherId) return missing();
    if (wanted === 0) return ok(await this.finalView(books, settings, viewer, book, role));
    const kind = book.periodKind as PeriodKind;
    const periods = await books.periods(book.yearId);
    const day = today(this.clock.now());
    const position = wanted && periods.some((p) => p.position === wanted) ? wanted : (periods.find((p) => p.startsOn <= day && day <= p.endsOn)?.position ?? [...periods].reverse().find((p) => p.startsOn <= day)?.position ?? periods[0]?.position ?? 1);
    const term = await books.term(groupId, subjectId, position);
    const [model, all, types, exams, publications] = await Promise.all([
      this.modelFor(settings, book, position, term),
      books.assessments(groupId, subjectId, null),
      settings.types(),
      books.calendarExams(book.yearId, groupId, subjectId, position),
      books.publications(groupId, subjectId, position),
    ]);
    const { assessments, rows, typeNames } = await this.compute(books, book, position, model, types);
    const d = model?.definition ?? null;
    const comps = new Map((d?.components ?? []).map((c) => [c.key, c]));
    // com média (ou, nos qualitativos, com menção); a média da turma só com números
    const done = rows.filter((r) => r.result?.status === "DONE");
    const valued = done.filter((r) => r.result!.value !== null);
    const open = book.yearStatus !== "CLOSED";
    const editable = EDITABLE.includes(term?.status ?? null);
    const validator = role === "COORDINATOR" || !!viewer.canValidate;
    return ok({
      role,
      can: {
        edit: role === "TEACHER" && open && !!model && editable,
        submit: role === "TEACHER" && open && !!model && editable,
        validate: open && validator && term?.status === "SUBMITTED",
        return: open && validator && (term?.status === "SUBMITTED" || term?.status === "VALIDATED"),
        publish: open && !!viewer.canPublish && term?.status === "VALIDATED",
        reopen: open && !!viewer.canRectify && term?.status === "PUBLISHED",
      },
      /** o estado das classificações deste período (null = em preparação) */
      term: {
        status: term?.status ?? "DRAFT",
        label: termLabel(term),
        revision: term?.revision ?? 0,
        note: term?.note ?? null,
        submittedAt: term?.submittedAt?.toISOString() ?? null,
        submittedBy: term?.submittedBy ?? null,
        validatedAt: term?.validatedAt?.toISOString() ?? null,
        validatedBy: term?.validatedBy ?? null,
        publishedAt: term?.publishedAt?.toISOString() ?? null,
        publishedBy: term?.publishedBy ?? null,
        publications: publications.map((p) => ({ number: p.number, at: p.publishedAt.toISOString(), by: p.publishedBy, reason: p.reason })),
      },
      year: { id: book.yearId, name: book.yearName, status: book.yearStatus, periodKind: kind },
      group: { id: book.groupId, name: book.groupName, classLabel: gradeName(book.grade, book.courseName), shift: book.shift },
      subject: { id: book.subjectId, name: book.subjectName, code: book.subjectCode, color: book.subjectColor },
      teacher: book.teacherName,
      periods: [
        ...periods.map((p) => ({ position: p.position, name: periodName(kind, p.position), startsOn: p.startsOn, endsOn: p.endsOn, assessments: all.filter((a) => a.period === p.position).length })),
        ...(periods.length ? [{ position: 0, name: termName(kind, 0), startsOn: periods[0].startsOn, endsOn: periods[periods.length - 1].endsOn, assessments: 0 }] : []),
      ],
      period: position,
      final: null,
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

  // ================================================================ final do ano

  /** O modelo do ano: o do último período (a versão com que foi publicado, se já o foi). */
  private async yearModel(books: Books, settings: Settings, book: BookRow, periods: PeriodRow[]) {
    const last = periods[periods.length - 1];
    if (!last) return null;
    const [term, pubs] = await Promise.all([books.term(book.groupId, book.subjectId, last.position), books.latestPublications(book.groupId, book.subjectId)]);
    // a publicação do último período diz com que versão do modelo foi calculado (vale mesmo que o estado mude depois)
    const pub = pubs.find((p) => p.period === last.position);
    if (pub?.modelId && pub.modelVersion) return this.modelFor(settings, book, last.position, { ...(term ?? ({} as TermRow)), publications: Math.max(1, term?.publications ?? 0), modelId: pub.modelId, modelVersion: pub.modelVersion });
    return this.modelFor(settings, book, last.position, term);
  }

  /**
   * A nota final de cada aluno com o motor oficial: as médias PUBLICADAS de cada período (a última
   * publicação, retificações incluídas), o exame e a recuperação lançados no "Final do ano".
   */
  private async computeYear(books: Books, settings: Settings, book: BookRow) {
    const periods = await books.periods(book.yearId);
    const [model, students, pubs, marks] = await Promise.all([this.yearModel(books, settings, book, periods), books.students(book.groupId), books.latestPublications(book.groupId, book.subjectId), books.finalMarks(book.groupId, book.subjectId)]);
    const d = model?.definition ?? null;
    const kind = book.periodKind as PeriodKind;
    const missing = periods.filter((p) => !pubs.some((x) => x.period === p.position)).map((p) => periodName(kind, p.position));
    const levelKey = (label: string | null) => (label ? (d?.levels.find((l) => l.label === label)?.key ?? null) : null);
    const rows = students.map((st) => {
      const per = periods.map((p) => {
        const pub = pubs.find((x) => x.period === p.position);
        const r = pub?.results.students.find((x) => x.id === st.id) ?? null;
        return { position: p.position, value: r?.value ?? null, level: r?.level ?? null, status: !pub ? "UNPUBLISHED" : r ? r.status : "NOT_IN_GROUP" };
      });
      const m = marks.find((x) => x.studentId === st.id) ?? null;
      const exam = m?.examState ? { state: m.examState as "GRADED" | "ABSENT" | "ABSENT_JUSTIFIED", value: m.examValue, parts: Object.entries(m.examParts ?? {}).map(([key, value]) => ({ key, value })) } : null;
      const result: YearOutcome | null = d ? yearResult(d, { periods: per.map((p) => ({ value: p.value, level: levelKey(p.level), exempt: p.status === "EXEMPT" })), exam, recovery: m?.recovery ?? null }) : null;
      return { id: st.id, name: st.name, number: st.number, periods: per, marks: m && { examState: m.examState, examValue: m.examValue, examParts: m.examParts, recovery: m.recovery }, result };
    });
    return { model, periods, missing, rows };
  }

  /** A vista "Final do ano" de uma caderneta (com a mesma forma da de um período, mais `final`). */
  private async finalView(books: Books, settings: Settings, viewer: GradebookViewer, book: BookRow, role: BookRole) {
    const kind = book.periodKind as PeriodKind;
    const [{ model, periods, missing, rows }, term, all, publications] = await Promise.all([
      this.computeYear(books, settings, book),
      books.term(book.groupId, book.subjectId, 0),
      books.assessments(book.groupId, book.subjectId, null),
      books.publications(book.groupId, book.subjectId, 0),
    ]);
    const d = model?.definition ?? null;
    const done = rows.filter((r) => r.result?.status === "DONE");
    const valued = done.filter((r) => r.result!.value !== null);
    const open = book.yearStatus !== "CLOSED";
    const editable = EDITABLE.includes(term?.status ?? null);
    const ready = !!model && !missing.length && periods.length > 0;
    const validator = role === "COORDINATOR" || !!viewer.canValidate;
    return {
      role,
      can: {
        edit: role === "TEACHER" && open && ready && editable,
        submit: role === "TEACHER" && open && ready && editable,
        validate: open && validator && term?.status === "SUBMITTED",
        return: open && validator && (term?.status === "SUBMITTED" || term?.status === "VALIDATED"),
        publish: open && !!viewer.canPublish && term?.status === "VALIDATED",
        reopen: open && !!viewer.canRectify && term?.status === "PUBLISHED",
      },
      term: {
        status: term?.status ?? "DRAFT",
        label: termLabel(term),
        revision: term?.revision ?? 0,
        note: term?.note ?? null,
        submittedAt: term?.submittedAt?.toISOString() ?? null,
        submittedBy: term?.submittedBy ?? null,
        validatedAt: term?.validatedAt?.toISOString() ?? null,
        validatedBy: term?.validatedBy ?? null,
        publishedAt: term?.publishedAt?.toISOString() ?? null,
        publishedBy: term?.publishedBy ?? null,
        publications: publications.map((p) => ({ number: p.number, at: p.publishedAt.toISOString(), by: p.publishedBy, reason: p.reason })),
      },
      year: { id: book.yearId, name: book.yearName, status: book.yearStatus, periodKind: kind },
      group: { id: book.groupId, name: book.groupName, classLabel: gradeName(book.grade, book.courseName), shift: book.shift },
      subject: { id: book.subjectId, name: book.subjectName, code: book.subjectCode, color: book.subjectColor },
      teacher: book.teacherName,
      periods: [...periods.map((p) => ({ position: p.position, name: periodName(kind, p.position), startsOn: p.startsOn, endsOn: p.endsOn, assessments: all.filter((a) => a.period === p.position).length })), { position: 0, name: termName(kind, 0), startsOn: periods[0]?.startsOn ?? "", endsOn: periods[periods.length - 1]?.endsOn ?? "", assessments: 0 }],
      period: 0,
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
        components: [],
      },
      issue: !periods.length ? "O ano letivo ainda não tem os períodos definidos (Pedagógico → Ano letivo)." : !model ? "Esta disciplina ainda não tem modelo de avaliação: fale com a pedagogia." : missing.length ? `O final do ano faz-se depois de publicadas as classificações de todos os períodos (falta: ${missing.join(", ")}).` : null,
      types: [],
      states: [],
      assessments: [],
      exams: [],
      students: [],
      stats: {
        students: rows.length,
        done: done.length,
        pending: rows.filter((r) => r.result?.status === "PENDING").length,
        missing: rows.filter((r) => r.result?.status === "MISSING").length,
        passed: done.filter((r) => r.result!.passed).length,
        average: valued.length ? Math.round((valued.reduce((s, r) => s + r.result!.value!, 0) / valued.length) * 100) / 100 : null,
        statusLabels: STATUS_LABEL,
      },
      /** só no "Final do ano" */
      final: {
        exam: d && d.kind !== "QUALITATIVE" && d.exam.enabled ? { frequencyWeight: d.exam.frequencyWeight, examWeight: d.exam.examWeight, minFrequency: d.exam.minFrequency, waiveFrom: d.exam.waiveFrom, parts: d.exam.parts.map((p) => ({ key: p.key, name: p.name, weight: p.weight })) } : null,
        recovery: d && d.kind !== "QUALITATIVE" && d.recovery.enabled ? { minMark: d.recovery.minMark, maxSubjects: d.recovery.maxSubjects, result: d.recovery.result } : null,
        periodWeights: d?.periodWeights ?? null,
        missing,
        students: rows,
      },
    };
  }

  /** O professor lança o exame (classes de exame) e a prova de recuperação, no "Final do ano". */
  async setFinalMarks(books: Books, settings: Settings, viewer: GradebookViewer, groupId: string, subjectId: string, input: { marks: { studentId: string; examState?: "GRADED" | "ABSENT" | "ABSENT_JUSTIFIED" | null; examValue?: number | null; examParts?: Record<string, number | null> | null; recovery?: number | null }[] }): R<{ changed: number }> {
    const w = await this.writable(books, settings, viewer, await books.book(groupId, subjectId), 0);
    if (!w.ok) return w;
    const { book, model } = w.value;
    const d = model.definition;
    if (d.kind === "QUALITATIVE") return bad("Este modelo é só qualitativo: não tem exame nem recuperação.");
    if (input.marks.length > MAX_MARKS_PER_SAVE) return bad(`No máximo ${MAX_MARKS_PER_SAVE} alunos de cada vez.`);
    const { rows } = await this.computeYear(books, settings, book);
    const { min, max } = d.scale;
    const inScale = (n: number | null | undefined) => n === null || n === undefined || (Number.isFinite(n) && twoDecimals(n) && n >= min && n <= max);
    const entries: { studentId: string; examState: string | null; examValue: number | null; examParts: Record<string, number | null> | null; recovery: number | null }[] = [];
    for (const m of input.marks) {
      const row = rows.find((r) => r.id === m.studentId);
      if (!row) return bad("Há um aluno que não está nesta turma.");
      const examState = m.examState ?? null;
      let examValue = examState === "GRADED" ? (m.examValue ?? null) : null;
      let examParts: Record<string, number | null> | null = null;
      if (examState) {
        if (!d.exam.enabled) return bad("O modelo desta disciplina não tem exame.");
        if (examState === "GRADED" && d.exam.parts.length) {
          examParts = {};
          for (const p of d.exam.parts) examParts[p.key] = m.examParts?.[p.key] ?? null;
          if (Object.keys(m.examParts ?? {}).some((k) => !d.exam.parts.some((p) => p.key === k))) return bad("Há uma prova do exame que este modelo não tem.");
          if (!Object.values(examParts).every(inScale)) return bad(`As notas do exame vão de ${fmt(min)} a ${fmt(max)}.`);
          examValue = null;
        } else if (!inScale(examValue)) return bad(`A nota do exame vai de ${fmt(min)} a ${fmt(max)}.`);
      }
      const recovery = m.recovery ?? null;
      if (recovery !== null) {
        if (!d.recovery.enabled) return bad("O modelo desta disciplina não tem recuperação.");
        if (!inScale(recovery)) return bad(`A nota da recuperação vai de ${fmt(min)} a ${fmt(max)}.`);
        // só quem tem direito à recuperação (a nota final sem ela é negativa e chega ao mínimo)
        if (!row.result?.recovery?.eligible) return bad(`${row.name} não vai à recuperação nesta disciplina.`);
      }
      entries.push({ studentId: m.studentId, examState, examValue, examParts, recovery });
    }
    const actor = await this.actor(books, viewer);
    const changed = await books.locked(groupId, subjectId, (tx) => tx.setFinalMarks({ yearId: book.yearId, groupId, subjectId, period: 0 }, entries, actor, this.clock.now()));
    return ok({ changed });
  }

  /** As notas e a média de cada aluno num período, com o motor oficial (a vista e a submissão usam o mesmo). */
  private async compute(books: Books, book: BookRow, period: number, model: Model | null, types: { id: string; name: string }[]) {
    const [students, assessments, notes] = await Promise.all([books.students(book.groupId), books.assessments(book.groupId, book.subjectId, period), books.notes(book.groupId, book.subjectId, period)]);
    const typeNames = new Map(types.map((t) => [t.id, t.name]));
    const marks = await books.marks(assessments.map((a) => a.id));
    const d = model?.definition ?? null;
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
    return { assessments, rows, typeNames };
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
        const TERM: Record<string, string> = {
          TERM_SUBMITTED: "Submeteu as classificações para validação",
          TERM_RETURNED: "Devolveu as classificações ao professor",
          TERM_VALIDATED: "Validou as classificações",
          TERM_PUBLISHED: `Publicou as classificações${Number(h.after?.publication) > 1 ? ` (retificação ${Number(h.after?.publication) - 1})` : ""}`,
          TERM_REOPENED: "Reabriu as classificações para retificação",
        };
        const finalText = (x: Record<string, unknown> | null) =>
          !x ? "nada" : [x.examState ? `exame ${x.examState === "GRADED" ? (x.examValue !== null && x.examValue !== undefined ? fmt(Number(x.examValue)) : "por provas") : (MARK_STATES[x.examState as MarkState] ?? "").toLowerCase()}` : null, x.recovery !== null && x.recovery !== undefined ? `recuperação ${fmt(Number(x.recovery))}` : null].filter(Boolean).join(", ") || "nada";
        const text = TERM[h.kind]
          ? TERM[h.kind]
          : h.kind === "FINAL_MARK"
            ? `${h.studentName ?? "Aluno"} · final do ano: ${finalText(h.before)} → ${finalText(h.after)}`
            : h.kind === "ASSESSMENT_CREATED"
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
    const term = await books.term(a.groupId, a.subjectId, a.period);
    if (!EDITABLE.includes(term?.status ?? null)) return fail(gradingError("INVALID_STATE", LOCKED[term!.status]));
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

  // ================================================================ fecho dos períodos

  /**
   * O professor submete as classificações do período para validação. Só com todos os alunos com
   * média (ou dispensados): o que se submete fica congelado e é isso que se valida e publica.
   */
  async submitTerm(books: Books, settings: Settings, viewer: GradebookViewer, groupId: string, subjectId: string, period: number): R<{ status: TermStatus }> {
    const w = await this.writable(books, settings, viewer, await books.book(groupId, subjectId), period);
    if (!w.ok) return w;
    const { book, model } = w.value;
    const types = await settings.types();
    const actor = await this.actor(books, viewer);
    if (period === 0) return this.submitYear(books, settings, viewer, book, model);
    return books.locked(groupId, subjectId, async (tx): R<{ status: TermStatus }> => {
      const term = await tx.term(groupId, subjectId, period);
      if (!EDITABLE.includes(term?.status ?? null)) return fail(gradingError("INVALID_STATE", LOCKED[term!.status]));
      const { rows } = await this.compute(tx, book, period, model, types);
      if (!rows.length) return fail(gradingError("INVALID_STATE", "Esta turma não tem alunos: não há classificações a submeter."));
      const open = rows.filter((r) => r.result?.status !== "DONE" && r.result?.status !== "EXEMPT");
      if (open.length)
        return fail(
          gradingError("INCOMPLETE", `${open.length === 1 ? "Um aluno ainda não tem" : `${open.length} alunos ainda não têm`} a média do período: ${open.slice(0, 3).map((r) => r.name).join(", ")}${open.length > 3 ? "…" : ""}.`, {
            students: open.map((r) => ({ id: r.id, name: r.name, status: r.result?.status ?? "MISSING", notes: [...(r.result?.notes ?? []), ...(r.result?.components.flatMap((c) => c.notes) ?? [])] })),
          }),
        );
      const done = rows.filter((r) => r.result!.status === "DONE");
      const valued = done.filter((r) => r.result!.value !== null);
      const results: FrozenResults = {
        students: rows.map((r) => ({ id: r.id, name: r.name, number: r.number, status: r.result!.status, value: r.result!.value, level: r.result!.level?.label ?? null, passed: r.result!.passed, comment: r.note?.comment ?? null })),
        stats: { students: rows.length, done: done.length, passed: done.filter((r) => r.result!.passed).length, average: valued.length ? Math.round((valued.reduce((s, r) => s + r.result!.value!, 0) / valued.length) * 100) / 100 : null },
      };
      const k = { yearId: book.yearId, groupId, subjectId, period };
      return (await tx.submitTerm(k, term, { modelId: model.id, modelVersion: model.version, results }, actor, this.clock.now()))
        ? ok({ status: "SUBMITTED" as const })
        : fail(gradingError("CHANGED", "As classificações foram alteradas entretanto. Atualize a página."));
    });
  }

  /** Submete o "Final do ano": todos os alunos com nota final (exame lançado onde o há); fica congelado. */
  private async submitYear(books: Books, settings: Settings, viewer: GradebookViewer, book: BookRow, model: Model): R<{ status: TermStatus }> {
    const actor = await this.actor(books, viewer);
    return books.locked(book.groupId, book.subjectId, async (tx): R<{ status: TermStatus }> => {
      const term = await tx.term(book.groupId, book.subjectId, 0);
      if (!EDITABLE.includes(term?.status ?? null)) return fail(gradingError("INVALID_STATE", LOCKED[term!.status]));
      const { rows } = await this.computeYear(tx, settings, book);
      if (!rows.length) return fail(gradingError("INVALID_STATE", "Esta turma não tem alunos: não há classificações a submeter."));
      const open = rows.filter((r) => r.result?.status !== "DONE" && r.result?.status !== "EXEMPT");
      if (open.length)
        return fail(
          gradingError("INCOMPLETE", `${open.length === 1 ? "Um aluno ainda não tem" : `${open.length} alunos ainda não têm`} a nota final: ${open.slice(0, 3).map((r) => r.name).join(", ")}${open.length > 3 ? "…" : ""}.`, {
            students: open.map((r) => ({ id: r.id, name: r.name, status: r.result?.status ?? "MISSING", notes: r.result?.notes ?? [] })),
          }),
        );
      const d = model.definition;
      const done = rows.filter((r) => r.result!.status === "DONE");
      const valued = done.filter((r) => r.result!.value !== null);
      const results: FrozenResults = {
        students: rows.map((r) => {
          const y = r.result!;
          return {
            id: r.id,
            name: r.name,
            number: r.number,
            status: y.status,
            value: y.value,
            level: y.level?.label ?? null,
            passed: y.passed,
            comment: null,
            frequency: y.annual.value,
            exam: y.exam ? { status: y.exam.status, value: y.exam.value } : null,
            recovery: y.recovery?.value ?? null,
            // negativa e ainda pode ir à recuperação (não a fez)
            recoveryOpen: !!y.recovery?.eligible && y.recovery.value === null,
            recoveryMax: d.recovery.enabled ? d.recovery.maxSubjects : null,
          };
        }),
        stats: { students: rows.length, done: done.length, passed: done.filter((r) => r.result!.passed).length, average: valued.length ? Math.round((valued.reduce((s, r) => s + r.result!.value!, 0) / valued.length) * 100) / 100 : null },
      };
      const k = { yearId: book.yearId, groupId: book.groupId, subjectId: book.subjectId, period: 0 };
      return (await tx.submitTerm(k, term, { modelId: model.id, modelVersion: model.version, results }, actor, this.clock.now()))
        ? ok({ status: "SUBMITTED" as const })
        : fail(gradingError("CHANGED", "As classificações foram alteradas entretanto. Atualize a página."));
    });
  }

  /** Validar, devolver ao professor (com motivo) ou reabrir para retificação (com motivo). */
  async moveTerm(books: Books, viewer: GradebookViewer, groupId: string, subjectId: string, input: { period: number; revision: number; action: "validate" | "return" | "reopen"; reason?: string | null }): R<{ status: TermStatus }> {
    const book = await books.book(groupId, subjectId);
    if (!book) return missing();
    const role = await this.role(books, viewer, book);
    if (book.yearStatus === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const term = await books.term(groupId, subjectId, input.period);
    if (input.action === "reopen") {
      if (!viewer.canRectify) return fail(gradingError("FORBIDDEN", "Reabrir classificações publicadas exige a permissão “Abrir retificações”."));
    } else {
      // o professor da disciplina não valida as suas próprias classificações
      if (role === "TEACHER" || !(role === "COORDINATOR" || viewer.canValidate)) return fail(gradingError("FORBIDDEN", "Validar exige ser o diretor desta turma ou ter a permissão “Validar as classificações” (e não ser o professor da disciplina)."));
    }
    const reason = clean(input.reason) || null;
    if (input.action !== "validate" && (!reason || reason.length < 3)) return fail(gradingError("INVALID_INPUT", input.action === "return" ? "Diga ao professor porque devolve as classificações (fica no histórico)." : "Indique o motivo da retificação (fica no histórico e na publicação)."));
    if (reason && reason.length > 300) return bad("O motivo tem no máximo 300 caracteres.");
    const plan = {
      validate: { from: ["SUBMITTED"] as TermStatus[], to: "VALIDATED" as TermStatus, kind: "TERM_VALIDATED" as const, wrong: "Só se validam classificações submetidas pelo professor." },
      return: { from: ["SUBMITTED", "VALIDATED"] as TermStatus[], to: (term && term.publications > 0 ? "REOPENED" : "RETURNED") as TermStatus, kind: "TERM_RETURNED" as const, wrong: "Só se devolvem classificações submetidas ou validadas (ainda não publicadas)." },
      reopen: { from: ["PUBLISHED"] as TermStatus[], to: "REOPENED" as TermStatus, kind: "TERM_REOPENED" as const, wrong: "Só se reabrem classificações publicadas." },
    }[input.action];
    if (!term || !plan.from.includes(term.status)) return fail(gradingError("INVALID_STATE", plan.wrong));
    if (term.revision !== input.revision) return fail(gradingError("CHANGED", "As classificações mudaram de estado entretanto. Atualize a página."));
    const actor = await this.actor(books, viewer);
    const k = { yearId: book.yearId, groupId, subjectId, period: input.period };
    const done = await books.locked(groupId, subjectId, (tx) => tx.moveTerm(k, plan.from, plan.to, input.revision, plan.kind, reason, actor, this.clock.now()));
    return done ? ok({ status: plan.to }) : fail(gradingError("CHANGED", "As classificações mudaram de estado entretanto. Atualize a página."));
  }

  /** A direção publica as classificações validadas de uma turma num período (todas, ou só as disciplinas indicadas). */
  async publishGroup(books: Books, viewer: GradebookViewer, input: { groupId: string; period: number; subjectIds?: string[] | null }): R<{ published: number; notReady: string[]; subjects: { id: string; name: string; number: number }[] }> {
    if (!viewer.canPublish) return fail(gradingError("FORBIDDEN", "Publicar exige a permissão “Publicar as classificações”."));
    const group = await books.groupInfo(input.groupId);
    if (!group) return fail(gradingError("NOT_FOUND", "Turma não encontrada."));
    if (group.yearStatus === "CLOSED") return fail(gradingError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const [terms, subjects] = await Promise.all([books.terms(group.yearId, input.period), books.groupSubjects(input.groupId)]);
    const wanted = subjects.filter((s) => !input.subjectIds?.length || input.subjectIds.includes(s.id));
    const ready = wanted.filter((s) => terms.some((t) => t.groupId === input.groupId && t.subjectId === s.id && t.status === "VALIDATED"));
    const notReady = wanted.filter((s) => !terms.some((t) => t.groupId === input.groupId && t.subjectId === s.id && (t.status === "VALIDATED" || t.status === "PUBLISHED"))).map((s) => s.name);
    if (!ready.length) return fail(gradingError("INVALID_STATE", "Não há classificações validadas por publicar nesta turma e período."));
    const actor = await this.actor(books, viewer);
    const done: { id: string; name: string; number: number }[] = [];
    for (const s of ready) {
      const t = terms.find((x) => x.groupId === input.groupId && x.subjectId === s.id)!;
      const n = await books.locked(input.groupId, s.id, (tx) => tx.publishTerm({ yearId: group.yearId, groupId: input.groupId, subjectId: s.id, period: input.period }, t.revision, actor, this.clock.now()));
      if (n !== null) done.push({ id: s.id, name: s.name, number: n });
    }
    return ok({ published: done.length, notReady, subjects: done });
  }

  /** O estado das classificações de todas as turmas e disciplinas de um período (validação e publicação). */
  async termsOverview(books: Books, viewer: GradebookViewer, yearId?: string, wanted?: number) {
    const years = await books.years();
    const year = (yearId ? years.find((y) => y.id === yearId) : null) ?? (await books.currentYear(today(this.clock.now()))) ?? years[0] ?? null;
    if (!year) return { years: [], year: null, periods: [], period: 1, can: { validate: false, publish: false, rectify: false }, classes: [] };
    const periods = await books.periods(year.id);
    const day = today(this.clock.now());
    const period = wanted === 0 ? 0 : wanted && periods.some((p) => p.position === wanted) ? wanted : (periods.find((p) => p.startsOn <= day && day <= p.endsOn)?.position ?? [...periods].reverse().find((p) => p.startsOn <= day)?.position ?? 1);
    const [rows, terms] = await Promise.all([books.allBooks(year.id), books.terms(year.id, period)]);
    const kind = year.periodKind as PeriodKind;
    type Subject = { id: string; name: string; code: string; color: string; teacherName: string | null; assessments: number; status: TermStatus | "DRAFT"; label: string; revision: number; note: string | null };
    const classes = new Map<string, { id: string; grade: number; level: string; courseId: string | null; courseName: string | null; label: string; groups: Map<string, { id: string; name: string; students: number; subjects: Subject[] }> }>();
    for (const r of rows) {
      const t = terms.find((x) => x.groupId === r.groupId && x.subjectId === r.subjectId) ?? null;
      const c = classes.get(r.classId) ?? { id: r.classId, grade: r.grade, level: levelOf(r.grade), courseId: r.courseId, courseName: r.courseName, label: gradeName(r.grade, r.courseName), groups: new Map() };
      const g = c.groups.get(r.groupId) ?? { id: r.groupId, name: r.groupName, students: r.students, subjects: [] };
      g.subjects.push({ id: r.subjectId, name: r.subjectName, code: r.subjectCode, color: r.subjectColor, teacherName: r.teacherName, assessments: r.assessments, status: t?.status ?? "DRAFT", label: termLabel(t), revision: t?.revision ?? 0, note: t?.note ?? null });
      c.groups.set(r.groupId, g);
      classes.set(r.classId, c);
    }
    return {
      years: years.map((y) => ({ id: y.id, name: y.name, status: y.status })),
      year: { id: year.id, name: year.name, status: year.status },
      periods: [...periods.map((p) => ({ position: p.position, name: periodName(kind, p.position) })), ...(periods.length ? [{ position: 0, name: termName(kind, 0) }] : [])],
      period,
      can: { validate: !!viewer.canValidate && year.status !== "CLOSED", publish: !!viewer.canPublish && year.status !== "CLOSED", rectify: !!viewer.canRectify && year.status !== "CLOSED" },
      classes: [...classes.values()].map((c) => ({ ...c, groups: [...c.groups.values()] })),
    };
  }
}
