import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { localNow } from "../../attendance/domain/presence";
import { type PeriodKind, periodName, PERIOD_KINDS } from "../../pedagogy/domain/calendar";
import {
  checkDates,
  checkExam,
  checkModel,
  checkReason,
  cleanLong,
  type Conflict,
  conflictsOf,
  dmy,
  type ExamCtx,
  type ExamError,
  examError,
  EXAM_LABELS,
  type ExamFormat,
  FORMAT_LABELS,
  isDay,
  MAX_PER_PERIOD,
  SEASON_LABELS,
  type SeasonCtx,
  type Slot,
  tidy,
  type YearCtx,
} from "../domain/exams";
import { checkOptions, examDays, generate, type GenerateOptions, MODE_LABELS, placedText, type Proposal } from "../domain/generator";
import type { NewExam, PrismaExamsRepository, PublicExam, YearRow } from "../infrastructure/prisma-exams";

type R<T> = Promise<Result<T, ExamError>>;
export interface ExamActor {
  id: string | null;
  canManage: boolean;
  canPublish: boolean;
  canGenerate: boolean;
}
export interface ExamInput {
  teacherId?: string | null;
  day: string;
  startsAt: string;
  endsAt: string;
  room?: string | null;
  format: string;
  notes?: string | null;
  confirm?: boolean;
  /** obrigatório ao alterar uma época já publicada */
  reason?: string | null;
}
/** AUTO = o professor da disciplina em cada turma. */
export const AUTO = "AUTO";

const formats = Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label }));
const examDto = (e: ExamCtx, groups: YearCtx["groups"]) => {
  const g = groups.find((x) => x.id === e.groupId);
  return {
    id: e.id,
    group: { id: e.groupId, label: g?.label ?? "", classId: g?.classId ?? "" },
    subject: { id: e.subjectId, name: e.subjectName, color: e.subjectColor },
    teacher: e.teacherId ? { id: e.teacherId, fullName: e.teacherName } : null,
    day: e.day,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    room: e.room ?? g?.room ?? null,
    ownRoom: e.room,
    format: e.format,
    formatLabel: FORMAT_LABELS[e.format],
    notes: e.notes,
    status: e.status,
    statusLabel: EXAM_LABELS[e.status],
    source: e.source,
    cancelReason: e.cancelReason,
  };
};
const publicDto = (e: PublicExam) => ({
  id: e.id,
  season: { id: e.seasonId, name: e.seasonName },
  group: { id: e.groupId, label: e.groupLabel },
  subject: { id: e.subjectId, name: e.subjectName, color: e.subjectColor },
  teacherName: e.teacherName,
  day: e.day,
  startsAt: e.startsAt,
  endsAt: e.endsAt,
  room: e.room ?? e.groupRoom,
  formatLabel: FORMAT_LABELS[e.format],
  notes: e.notes,
  status: e.status,
  statusLabel: EXAM_LABELS[e.status],
  cancelReason: e.cancelReason,
});
const slotOf = (e: ExamCtx): Slot => e;
/** Para o histórico. */
const examText = (e: Pick<ExamCtx, "subjectName" | "day" | "startsAt" | "endsAt" | "room" | "format" | "notes"> & { teacherName: string | null }, label: string) => ({
  prova: `${e.subjectName} · ${label}`,
  data: e.day,
  hora: `${e.startsAt}–${e.endsAt}`,
  professor: e.teacherName,
  sala: e.room,
  modalidade: FORMAT_LABELS[e.format],
  observações: e.notes,
});
const HISTORY: Record<string, string> = {
  EXAM_SEASON_CONFIGURED: "Época configurada",
  EXAM_SEASON_RENAMED: "Nome da prova alterado",
  EXAM_SEASON_EXTENDED: "Fim da época adiado",
  EXAM_SEASON_PUBLISHED: "Calendário publicado",
  EXAM_SEASON_UNPUBLISHED: "Voltou a preparação",
  EXAM_GENERATED: "Proposta automática aplicada",
  EXAM_CREATED: "Prova marcada",
  EXAM_UPDATED: "Prova alterada",
  EXAM_REMOVED: "Prova retirada",
  EXAM_CANCELLED: "Prova cancelada",
};

/**
 * CALENDÁRIO DE PROVAS (gestão). Ver: attendance.exams.view · preparar: attendance.exams.manage ·
 * publicar, e alterar o que já está publicado: attendance.exams.publish.
 * Cada alteração fica no histórico da época; com a época publicada, avisa professores e famílias.
 */
export class Exams {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  today(timeZone: string) {
    return localNow(timeZone, this.clock.now()).slice(0, 10);
  }

  // ============================================================ ver

  /** As épocas de um ano, por período de avaliação. */
  async overview(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, yearId?: string) {
    const today = this.today(timeZone);
    const years = await repo.years();
    const chosen = years.find((y) => y.id === yearId) ?? this.currentYear(years, today);
    const yearsDto = years.map((y) => ({ id: y.id, name: y.name, status: y.status }));
    if (!chosen) return { today, years: yearsDto, year: null, canManage: false, canPublish: false, max: MAX_PER_PERIOD, periods: [] };
    const [ctx, periods] = await Promise.all([repo.context(chosen.id), repo.periods(chosen.id)]);
    if (!ctx) return { today, years: yearsDto, year: null, canManage: false, canPublish: false, max: MAX_PER_PERIOD, periods: [] };
    const kind = chosen.periodKind as PeriodKind;
    const open = chosen.status !== "CLOSED";
    // os períodos do ano (e os que ainda têm provas, se o ano mudou de trimestres para semestres)
    const positions = [...new Set([...Array.from({ length: PERIOD_KINDS[kind].count }, (_, i) => i + 1), ...ctx.seasons.map((s) => s.periodPosition)])].sort();
    return {
      today,
      years: yearsDto,
      year: { id: chosen.id, name: chosen.name, status: chosen.status, startsOn: chosen.startsOn, endsOn: chosen.endsOn },
      canManage: actor.canManage && open,
      canPublish: actor.canPublish && open,
      max: MAX_PER_PERIOD,
      unit: PERIOD_KINDS[kind].unit,
      periods: positions.map((position) => {
        const p = periods.find((x) => x.position === position);
        const extra = position > PERIOD_KINDS[kind].count;
        return {
          position,
          name: extra ? "Fora dos períodos do ano" : periodName(kind, position),
          extra,
          startsOn: p?.startsOn ?? null,
          endsOn: p?.endsOn ?? null,
          current: !!p && today >= p.startsOn && today <= p.endsOn,
          seasons: ctx.seasons.filter((s) => s.periodPosition === position).map((s) => this.summary(ctx, s, today)),
        };
      }),
    };
  }

  /** O ano em curso; sem nenhum, o que abrange hoje, o próximo, ou o mais recente. */
  private currentYear(years: YearRow[], today: string) {
    const open = years.filter((y) => y.status !== "CLOSED").reverse();
    return years.find((y) => y.status === "ACTIVE") ?? open.find((y) => today >= y.startsOn && today <= y.endsOn) ?? open.find((y) => y.startsOn > today) ?? years[0];
  }

  private summary(ctx: YearCtx, s: SeasonCtx, today: string) {
    const exams = ctx.exams.filter((e) => e.seasonId === s.id);
    const scheduled = exams.filter((e) => e.status === "SCHEDULED");
    const expected = this.pairs(ctx, s).length;
    const phase = !s.startsOn || !s.endsOn ? "POR_CONFIGURAR" : s.status === "DRAFT" ? "A_PREPARAR" : today < s.startsOn ? "PUBLICADA" : today <= s.endsOn ? "A_DECORRER" : "TERMINADA";
    return {
      id: s.id,
      name: s.name,
      position: s.position,
      periodPosition: s.periodPosition,
      startsOn: s.startsOn,
      endsOn: s.endsOn,
      interrupts: s.interrupts,
      format: s.format,
      formatLabel: FORMAT_LABELS[s.format],
      notes: s.notes,
      status: s.status,
      statusLabel: SEASON_LABELS[s.status],
      phase,
      phaseLabel: { POR_CONFIGURAR: "Por configurar", A_PREPARAR: "A preparar", PUBLICADA: "Publicada", A_DECORRER: "A decorrer", TERMINADA: "Terminada" }[phase] as string,
      publishedAt: s.publishedAt,
      groups: s.groupIds.length,
      expected,
      scheduled: scheduled.length,
      missing: this.missing(ctx, s).length,
      cancelled: exams.length - scheduled.length,
    };
  }

  /** Cada turma abrangida × disciplina abrangida na sua classe: as provas esperadas. */
  private pairs(ctx: YearCtx, s: SeasonCtx) {
    return s.groupIds.flatMap((gid) => {
      const g = ctx.groups.find((x) => x.id === gid);
      return g ? s.subjects.filter((x) => x.classId === g.classId).map((x) => ({ groupId: g.id, label: g.label, subjectId: x.subjectId })) : [];
    });
  }

  private missing(ctx: YearCtx, s: SeasonCtx) {
    const has = new Set(ctx.exams.filter((e) => e.seasonId === s.id && e.status === "SCHEDULED").map((e) => `${e.groupId}:${e.subjectId}`));
    return this.pairs(ctx, s).filter((p) => !has.has(`${p.groupId}:${p.subjectId}`));
  }

  /** Os conflitos de todas as provas da época (cada um com a prova). */
  private problems(ctx: YearCtx, s: SeasonCtx, today: string) {
    return ctx.exams
      .filter((e) => e.seasonId === s.id && e.status === "SCHEDULED")
      .flatMap((e) =>
        conflictsOf(ctx, slotOf(e), today)
          // depois de publicada, uma prova que já foi não é problema
          .filter((c) => !(c.code === "PAST" && s.status === "PUBLISHED"))
          .map((c) => ({ ...c, examId: e.id, exam: `${e.subjectName} · ${ctx.groups.find((g) => g.id === e.groupId)?.label ?? ""} · ${dmy(e.day)} ${e.startsAt}` })),
      )
      .sort((a, b) => (a.level === b.level ? 0 : a.level === "BLOCK" ? -1 : 1));
  }

  async season(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, id: string) {
    const yearId = await repo.yearOfSeason(id);
    const [ctx, choices, history, periods] = yearId ? await Promise.all([repo.context(yearId), repo.choices(yearId), repo.history(id, 100), repo.periods(yearId)]) : [null, null, [], []];
    const s = ctx?.seasons.find((x) => x.id === id);
    if (!ctx || !s || !choices) return fail(examError("NOT_FOUND", "Época de provas não encontrada."));
    const today = this.today(timeZone);
    const open = ctx.year.status !== "CLOSED";
    const ended = !!s.endsOn && today > s.endsOn;
    const names = new Map(choices.plan.map((p) => [p.subjectId, p.name]));
    const kind = ctx.year.periodKind as PeriodKind;
    const published = s.status === "PUBLISHED";
    const span = periods.find((p) => p.position === s.periodPosition);
    return ok({
      today,
      year: { id: ctx.year.id, name: ctx.year.name, startsOn: ctx.year.startsOn, endsOn: ctx.year.endsOn, closed: !open },
      period: { position: s.periodPosition, name: s.periodPosition > PERIOD_KINDS[kind].count ? "Fora dos períodos do ano" : periodName(kind, s.periodPosition), startsOn: span?.startsOn ?? null, endsOn: span?.endsOn ?? null },
      season: { ...this.summary(ctx, s, today), groupIds: s.groupIds, subjects: s.subjects },
      can: {
        configure: open && actor.canManage && !published,
        /** marcar e alterar provas: a preparar, quem gere; publicada, quem publica (e só o que ainda não passou) */
        edit: open && !!s.startsOn && (published ? actor.canManage && actor.canPublish && !ended : actor.canManage),
        generate: open && actor.canGenerate && !published && !!s.startsOn && !ended,
        publish: open && actor.canPublish && !published && !!s.startsOn && !ended,
        /** só antes de começar: depois, voltar atrás poria como "em falta" aulas que não houve */
        unpublish: open && actor.canPublish && published && !!s.startsOn && today < s.startsOn,
        extend: open && actor.canPublish && published && !ended,
      },
      formats,
      groups: ctx.groups.map((g) => ({ id: g.id, label: g.label, classId: g.classId, grade: g.grade, courseId: g.courseId, courseName: g.courseName, shift: g.shift, room: g.room, covered: s.groupIds.includes(g.id) })),
      plan: choices.plan,
      groupTeachers: choices.groupTeachers,
      teachers: choices.teachers,
      slots: choices.slots,
      lessons: ctx.lessons.filter((l) => s.groupIds.includes(l.groupId)),
      closures: ctx.closures,
      /** dias da época em que se pode fazer provas (de hoje em diante, sem domingos nem dias sem aulas) */
      availableDays: this.availableDays(ctx, s, today),
      exams: ctx.exams.filter((e) => e.seasonId === id).map((e) => examDto(e, ctx.groups)),
      missing: this.missing(ctx, s).map((m) => ({ ...m, subjectName: names.get(m.subjectId) ?? "—" })),
      problems: this.problems(ctx, s, today),
      history: history.map((h) => ({ at: h.at.toISOString(), action: h.type, label: HISTORY[h.type] ?? h.type, by: h.by, details: h.details })),
    });
  }

  // ============================================================ preparar

  /** A época e o contexto do ano, dentro do bloqueio; valida permissões e o estado. */
  private async within<T>(repo: PrismaExamsRepository, seasonId: string, work: (tx: PrismaExamsRepository, ctx: YearCtx, s: SeasonCtx) => R<T>): R<T> {
    const yearId = await repo.yearOfSeason(seasonId);
    if (!yearId) return fail(examError("NOT_FOUND", "Época de provas não encontrada."));
    return repo.locked(yearId, async (tx): R<T> => {
      const ctx = await tx.context(yearId);
      const s = ctx?.seasons.find((x) => x.id === seasonId);
      if (!ctx || !s) return fail(examError("NOT_FOUND", "Época de provas não encontrada."));
      if (ctx.year.status === "CLOSED") return fail(examError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
      return work(tx, ctx, s);
    });
  }

  /** Quantas provas há num período e como se chamam. */
  async setModel(repo: PrismaExamsRepository, actor: ExamActor, yearId: string, position: number, input: { id?: string | null; name: string }[]): R<{ saved: number }> {
    if (!actor.canManage) return fail(examError("FORBIDDEN", "Não tem permissão para gerir o calendário de provas."));
    const checked = checkModel(input);
    if (!checked.ok) return checked;
    return repo.locked(yearId, async (tx): R<{ saved: number }> => {
      const ctx = await tx.context(yearId);
      if (!ctx) return fail(examError("NOT_FOUND", "Ano letivo não encontrado."));
      if (ctx.year.status === "CLOSED") return fail(examError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
      const current = ctx.seasons.filter((s) => s.periodPosition === position);
      const isNew = checked.value.some((i) => !i.id);
      if (position > PERIOD_KINDS[ctx.year.periodKind as PeriodKind].count && isNew) return fail(examError("INVALID_INPUT", "Esse período não existe neste ano letivo."));
      if (checked.value.some((i) => i.id && !current.some((s) => s.id === i.id))) return fail(examError("NOT_FOUND", "Uma das provas já não existe. Atualize a página."));
      const keep = new Set(checked.value.map((i) => i.id));
      const gone = current.filter((s) => !keep.has(s.id));
      const blocked = gone.find((s) => s.status === "PUBLISHED" || ctx.exams.some((e) => e.seasonId === s.id));
      if (blocked) return fail(examError("INVALID_STATE", `"${blocked.name}" já tem provas marcadas${blocked.status === "PUBLISHED" ? " e está publicada" : ""}: retire-as primeiro.`));
      const renamed = checked.value.flatMap((i) => {
        const old = current.find((s) => s.id === i.id);
        return old && old.name !== i.name ? [{ old, name: i.name }] : [];
      });
      const pub = renamed.find((x) => x.old.status === "PUBLISHED");
      if (pub && !actor.canPublish) return fail(examError("FORBIDDEN", `"${pub.old.name}" está publicada: só quem publica lhe pode mudar o nome.`));
      const now = this.clock.now();
      await tx.saveModel(
        yearId,
        position,
        checked.value,
        gone.map((s) => s.id),
        actor.id,
        now,
      );
      for (const x of renamed) await tx.record("EXAM_SEASON_RENAMED", x.old.id, actor.id, { before: { nome: x.old.name }, after: { nome: x.name } }, now);
      await tx.record("EXAM_MODEL_SET", yearId, actor.id, { period: position, before: current.map((s) => s.name), after: checked.value.map((s) => s.name) }, now);
      return ok({ saved: checked.value.length });
    });
  }

  /** Datas, interrupção das aulas, modalidade habitual, turmas e disciplinas abrangidas. */
  async configure(
    repo: PrismaExamsRepository,
    actor: ExamActor,
    id: string,
    input: { startsOn: string; endsOn: string; interrupts: boolean; format: string; notes?: string | null; groupIds: string[]; subjects: { classId: string; subjectIds: string[] }[] },
  ): R<{ saved: true; problems: number }> {
    if (!actor.canManage) return fail(examError("FORBIDDEN", "Não tem permissão para gerir o calendário de provas."));
    return this.within(repo, id, async (tx, ctx, s): R<{ saved: true; problems: number }> => {
      if (s.status === "PUBLISHED") return fail(examError("INVALID_STATE", "A época está publicada. Para mudar a configuração, volte a pô-la em preparação."));
      const dates = checkDates(ctx.year, input.startsOn, input.endsOn);
      if (!dates.ok) return dates;
      if (!(input.format in FORMAT_LABELS)) return fail(examError("INVALID_INPUT", "Escolha a modalidade."));
      const notes = cleanLong(input.notes) || null;
      if (notes && notes.length > 500) return fail(examError("INVALID_INPUT", "As observações têm no máximo 500 caracteres."));
      const groupIds = [...new Set(input.groupIds)];
      if (!groupIds.length) return fail(examError("INVALID_INPUT", "Escolha pelo menos uma turma."));
      const groups = groupIds.map((g) => ctx.groups.find((x) => x.id === g));
      if (groups.some((g) => !g)) return fail(examError("INVALID_INPUT", "Há uma turma que não pertence a este ano letivo."));
      const classes = new Set(groups.map((g) => g!.classId));
      const plan = (await tx.choices(ctx.year.id)).plan;
      const subjects = input.subjects.filter((x) => classes.has(x.classId)).flatMap((x) => [...new Set(x.subjectIds)].map((subjectId) => ({ classId: x.classId, subjectId })));
      const outside = subjects.find((x) => !plan.some((p) => p.classId === x.classId && p.subjectId === x.subjectId) && !s.subjects.some((o) => o.classId === x.classId && o.subjectId === x.subjectId));
      if (outside) return fail(examError("INVALID_INPUT", "Há uma disciplina que não está no plano curricular da classe."));
      for (const c of classes) if (!subjects.some((x) => x.classId === c)) return fail(examError("INVALID_INPUT", `Escolha pelo menos uma disciplina para ${groups.find((g) => g!.classId === c)!.label.replace(/ \S+$/, "")}.`));
      const now = this.clock.now();
      const value = { startsOn: input.startsOn, endsOn: input.endsOn, interrupts: input.interrupts, format: input.format as ExamFormat, notes, groupIds, subjects };
      await tx.configure(id, value, now);
      const text = (v: { startsOn: string | null; endsOn: string | null; interrupts: boolean; format: ExamFormat; groupIds: string[]; subjects: unknown[]; notes: string | null }) => ({
        datas: v.startsOn ? `${v.startsOn} a ${v.endsOn}` : null,
        aulas: v.interrupts ? "Interrompidas" : "Mantêm-se",
        modalidade: FORMAT_LABELS[v.format],
        turmas: v.groupIds.length,
        disciplinas: v.subjects.length,
        observações: v.notes,
      });
      await tx.record("EXAM_SEASON_CONFIGURED", id, actor.id, { before: s.startsOn ? text(s) : null, after: text(value) }, now);
      // provas que ficaram fora (datas, turmas ou disciplinas): não se apagam, mostram-se como conflito
      const next = { ...ctx, seasons: ctx.seasons.map((x) => (x.id === id ? { ...x, ...value } : x)) };
      return ok({ saved: true as const, problems: this.problems(next, next.seasons.find((x) => x.id === id)!, "0000-00-00").filter((p) => p.level === "BLOCK").length });
    });
  }

  /** Pode mexer nas provas desta época? (a preparar: quem gere; publicada: quem gere e publica, com motivo) */
  private editable(actor: ExamActor, s: SeasonCtx, today: string): Result<void, ExamError> {
    if (!actor.canManage) return fail(examError("FORBIDDEN", "Não tem permissão para gerir o calendário de provas."));
    if (!s.startsOn || !s.endsOn) return fail(examError("INVALID_STATE", "Configure primeiro a época: datas, turmas e disciplinas."));
    if (s.status === "DRAFT") return ok(undefined);
    if (!actor.canPublish) return fail(examError("FORBIDDEN", "O calendário está publicado: só quem publica o pode alterar."));
    if (today > s.endsOn) return fail(examError("INVALID_STATE", "A época já terminou: fica só para consulta."));
    return ok(undefined);
  }

  private gate(conflicts: Conflict[], confirm: boolean | undefined): Result<void, ExamError> {
    const blocks = conflicts.filter((c) => c.level === "BLOCK");
    if (blocks.length) return fail(examError("CONFLICTS", blocks[0].message, { conflicts }));
    if (conflicts.length && !confirm) return fail(examError("NEEDS_CONFIRMATION", "Há avisos: confirme para guardar.", { conflicts }));
    return ok(undefined);
  }

  /** As provas a marcar (uma por turma) e os conflitos, sem gravar nada. */
  private plan(ctx: YearCtx, s: SeasonCtx, choices: Awaited<ReturnType<PrismaExamsRepository["choices"]>>, input: ExamInput & { groupIds: string[]; subjectId: string }, today: string): Result<{ exams: NewExam[]; conflicts: Conflict[] }, ExamError> {
    const data = checkExam(input);
    if (!data.ok) return data;
    const groupIds = [...new Set(input.groupIds)];
    if (!groupIds.length) return fail(examError("INVALID_INPUT", "Escolha pelo menos uma turma."));
    const subject = choices.plan.find((p) => p.subjectId === input.subjectId);
    if (!subject) return fail(examError("INVALID_INPUT", "Escolha a disciplina."));
    const auto = input.teacherId === AUTO;
    if (input.teacherId && !auto && !choices.teachers.some((t) => t.id === input.teacherId)) return fail(examError("INVALID_INPUT", "Escolha um professor do colégio."));
    const acc: YearCtx = { ...ctx, exams: [...ctx.exams] };
    const exams: NewExam[] = [];
    const conflicts: Conflict[] = [];
    for (const groupId of groupIds) {
      const teacherId = auto ? (choices.groupTeachers.find((t) => t.groupId === groupId && t.subjectId === input.subjectId)?.employeeId ?? null) : (input.teacherId ?? null);
      const teacherName = choices.teachers.find((t) => t.id === teacherId)?.fullName ?? null;
      const e: NewExam = { id: this.ids.next(), seasonId: s.id, groupId, subjectId: input.subjectId, teacherId, ...data.value };
      const full: ExamCtx = { ...e, subjectName: subject.name, subjectColor: subject.color, teacherName, status: "SCHEDULED", source: "MANUAL", cancelReason: null, updatedAt: "" };
      const dup = ctx.exams.find((o) => o.seasonId === s.id && o.status === "SCHEDULED" && o.groupId === groupId && o.subjectId === input.subjectId && o.format === e.format);
      const label = ctx.groups.find((g) => g.id === groupId)?.label ?? "";
      if (dup) conflicts.push({ level: "BLOCK", code: "EXAM_EXISTS", message: `A turma ${label} já tem a prova ${FORMAT_LABELS[e.format].toLowerCase()} de ${subject.name} nesta época (${dmy(dup.day)} às ${dup.startsAt}).` });
      else conflicts.push(...conflictsOf(acc, full, today));
      acc.exams.push(full);
      exams.push(e);
    }
    return ok({ exams, conflicts: tidy(conflicts) });
  }

  /** Só verifica (o portal mostra os conflitos enquanto se preenche). */
  async check(repo: PrismaExamsRepository, timeZone: string, seasonId: string, input: ExamInput & { groupIds: string[]; subjectId: string; examId?: string | null }): R<{ conflicts: Conflict[] }> {
    const yearId = await repo.yearOfSeason(seasonId);
    const [ctx, choices] = yearId ? await Promise.all([repo.context(yearId), repo.choices(yearId)]) : [null, null];
    const s = ctx?.seasons.find((x) => x.id === seasonId);
    if (!ctx || !s || !choices) return fail(examError("NOT_FOUND", "Época de provas não encontrada."));
    const p = this.plan(input.examId ? { ...ctx, exams: ctx.exams.filter((e) => e.id !== input.examId) } : ctx, s, choices, input, this.today(timeZone));
    return p.ok ? ok({ conflicts: p.value.conflicts }) : p;
  }

  /** Marca a prova de uma disciplina numa ou em várias turmas. */
  async create(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, seasonId: string, input: ExamInput & { groupIds: string[]; subjectId: string }): R<{ ids: string[]; conflicts: Conflict[] }> {
    const today = this.today(timeZone);
    return this.within(repo, seasonId, async (tx, ctx, s): R<{ ids: string[]; conflicts: Conflict[] }> => {
      const can = this.editable(actor, s, today);
      if (!can.ok) return can;
      const choices = await tx.choices(ctx.year.id);
      const p = this.plan(ctx, s, choices, input, today);
      if (!p.ok) return p;
      const { exams, conflicts } = p.value;
      if (s.status === "PUBLISHED" && exams.some((e) => e.day < today)) return fail(examError("INVALID_INPUT", "Com o calendário publicado, só se marcam provas de hoje em diante."));
      const g = this.gate(conflicts, input.confirm);
      if (!g.ok) return g;
      const now = this.clock.now();
      const reason = s.status === "PUBLISHED" ? checkReason(input.reason) : null;
      if (reason && !reason.ok) return reason;
      await tx.insert(exams, actor.id, now);
      const subjectName = choices.plan.find((x) => x.subjectId === input.subjectId)!.name;
      for (const e of exams) {
        const label = ctx.groups.find((x) => x.id === e.groupId)?.label ?? "";
        await tx.record("EXAM_CREATED", seasonId, actor.id, { after: examText({ ...e, subjectName, teacherName: choices.teachers.find((t) => t.id === e.teacherId)?.fullName ?? null }, label), ...(reason ? { reason: reason.value } : {}) }, now);
      }
      if (reason)
        await tx.addNotice(
          {
            seasonId,
            groupIds: exams.map((e) => e.groupId),
            subjectId: input.subjectId,
            teacherIds: exams.flatMap((e) => (e.teacherId ? [e.teacherId] : [])),
            title: `Nova prova de ${subjectName}`,
            body: `${s.name}: ${subjectName}, ${dmy(exams[0].day)} das ${exams[0].startsAt} às ${exams[0].endsAt}. Motivo: ${reason.value}`,
          },
          now,
        );
      return ok({ ids: exams.map((e) => e.id), conflicts });
    });
  }

  /** A prova e o que é preciso para a alterar. */
  private async withinExam<T>(repo: PrismaExamsRepository, actor: ExamActor, today: string, examId: string, work: (tx: PrismaExamsRepository, ctx: YearCtx, s: SeasonCtx, e: ExamCtx, label: string) => R<T>): R<T> {
    const ref = await repo.seasonOfExam(examId);
    if (!ref) return fail(examError("NOT_FOUND", "Prova não encontrada."));
    return this.within(repo, ref.seasonId, async (tx, ctx, s): R<T> => {
      const e = ctx.exams.find((x) => x.id === examId);
      if (!e) return fail(examError("NOT_FOUND", "Prova não encontrada."));
      const can = this.editable(actor, s, today);
      if (!can.ok) return can;
      if (e.status === "CANCELLED") return fail(examError("INVALID_STATE", "A prova está cancelada."));
      if (s.status === "PUBLISHED" && e.day < today) return fail(examError("INVALID_STATE", "A prova já foi: fica só para consulta."));
      return work(tx, ctx, s, e, ctx.groups.find((g) => g.id === e.groupId)?.label ?? "");
    });
  }

  async update(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, examId: string, input: ExamInput): R<{ saved: true; conflicts: Conflict[] }> {
    const today = this.today(timeZone);
    const r = await repo.uniqueOr(() =>
      this.withinExam(repo, actor, today, examId, async (tx, ctx, s, e, label): R<{ saved: true; conflicts: Conflict[] }> => {
        const data = checkExam(input);
        if (!data.ok) return data;
        const choices = await tx.choices(ctx.year.id);
        const teacherId = input.teacherId === AUTO ? (choices.groupTeachers.find((t) => t.groupId === e.groupId && t.subjectId === e.subjectId)?.employeeId ?? null) : (input.teacherId ?? null);
        if (teacherId && teacherId !== e.teacherId && !choices.teachers.some((t) => t.id === teacherId)) return fail(examError("INVALID_INPUT", "Escolha um professor do colégio."));
        if (s.status === "PUBLISHED" && data.value.day < today) return fail(examError("INVALID_INPUT", "Com o calendário publicado, só se marcam provas de hoje em diante."));
        const teacherName = teacherId === e.teacherId ? e.teacherName : (choices.teachers.find((t) => t.id === teacherId)?.fullName ?? null);
        const next: ExamCtx = { ...e, ...data.value, teacherId, teacherName };
        const before = examText(e, label);
        const after = examText(next, label);
        if (JSON.stringify(before) === JSON.stringify(after) && teacherId === e.teacherId) return ok({ saved: true as const, conflicts: [] });
        const conflicts = tidy(conflictsOf(ctx, next, today));
        const g = this.gate(conflicts, input.confirm);
        if (!g.ok) return g;
        const reason = s.status === "PUBLISHED" ? checkReason(input.reason) : null;
        if (reason && !reason.ok) return reason;
        const now = this.clock.now();
        await tx.update(examId, { teacherId, ...data.value }, actor.id, now);
        await tx.record("EXAM_UPDATED", s.id, actor.id, { before, after, ...(reason ? { reason: reason.value } : {}) }, now);
        if (reason) {
          const moved = e.day !== next.day || e.startsAt !== next.startsAt || e.endsAt !== next.endsAt;
          await tx.addNotice(
            {
              seasonId: s.id,
              groupIds: [e.groupId],
              subjectId: e.subjectId,
              teacherIds: [e.teacherId, teacherId].filter((t): t is string => !!t),
              title: `Prova de ${e.subjectName} alterada`,
              body: `${s.name} · ${label}: ${moved ? `passou de ${dmy(e.day)} às ${e.startsAt} para ${dmy(next.day)}, das ${next.startsAt} às ${next.endsAt}` : `${dmy(next.day)}, das ${next.startsAt} às ${next.endsAt}`}${next.room && next.room !== e.room ? `, sala ${next.room}` : ""}. Motivo: ${reason.value}`,
            },
            now,
          );
        }
        return ok({ saved: true as const, conflicts });
      }),
    );
    return r ?? fail(examError("EXAM_EXISTS", "A turma já tem uma prova desta disciplina com essa modalidade nesta época."));
  }

  /** Retira uma prova (só enquanto se prepara; publicada, cancela-se). */
  async remove(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, examId: string): R<{ removed: true }> {
    return this.withinExam(repo, actor, this.today(timeZone), examId, async (tx, _ctx, s, e, label): R<{ removed: true }> => {
      if (s.status === "PUBLISHED") return fail(examError("INVALID_STATE", "O calendário está publicado: cancele a prova, com o motivo."));
      const now = this.clock.now();
      await tx.remove(examId);
      await tx.record("EXAM_REMOVED", s.id, actor.id, { before: examText(e, label) }, now);
      return ok({ removed: true as const });
    });
  }

  async cancel(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, examId: string, rawReason: string): R<{ cancelled: true }> {
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    return this.withinExam(repo, actor, this.today(timeZone), examId, async (tx, _ctx, s, e, label): R<{ cancelled: true }> => {
      const now = this.clock.now();
      await tx.cancel(examId, reason.value, actor.id, now);
      await tx.record("EXAM_CANCELLED", s.id, actor.id, { before: examText(e, label), reason: reason.value }, now);
      if (s.status === "PUBLISHED")
        await tx.addNotice(
          {
            seasonId: s.id,
            groupIds: [e.groupId],
            subjectId: e.subjectId,
            teacherIds: e.teacherId ? [e.teacherId] : [],
            title: `Prova de ${e.subjectName} cancelada`,
            body: `${s.name} · ${label}: a prova de ${dmy(e.day)} às ${e.startsAt} foi cancelada. Motivo: ${reason.value}`,
          },
          now,
        );
      return ok({ cancelled: true as const });
    });
  }

  // ============================================================ gerar automaticamente

  private propose(ctx: YearCtx, s: SeasonCtx, choices: Awaited<ReturnType<PrismaExamsRepository["choices"]>>, opts: GenerateOptions, today: string): Result<Proposal, ExamError> {
    if (ctx.year.status === "CLOSED") return fail(examError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    if (s.status === "PUBLISHED") return fail(examError("INVALID_STATE", "O calendário está publicado: a proposta automática só se usa em preparação."));
    if (!s.startsOn || !s.endsOn) return fail(examError("INVALID_STATE", "Configure primeiro a época: datas, turmas e disciplinas."));
    if (today > s.endsOn) return fail(examError("INVALID_STATE", "As datas desta época já passaram."));
    return ok(generate(ctx, s, choices.plan, { groupTeachers: choices.groupTeachers, names: new Map(choices.teachers.map((t) => [t.id, t.fullName])) }, opts, today));
  }

  /** A proposta (sem gravar nada): o que põe, o que não cabe, o que mantém e o que substitui. */
  async preview(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, seasonId: string, input: GenerateOptions) {
    if (!actor.canGenerate) return fail(examError("FORBIDDEN", "Não tem permissão para gerar o calendário de provas."));
    const opts = checkOptions(input);
    if (!opts.ok) return opts;
    const yearId = await repo.yearOfSeason(seasonId);
    const [ctx, choices] = yearId ? await Promise.all([repo.context(yearId), repo.choices(yearId)]) : [null, null];
    const s = ctx?.seasons.find((x) => x.id === seasonId);
    if (!ctx || !s || !choices) return fail(examError("NOT_FOUND", "Época de provas não encontrada."));
    const p = this.propose(ctx, s, choices, opts.value, this.today(timeZone));
    if (!p.ok) return p;
    const label = new Map(ctx.groups.map((g) => [g.id, g.label]));
    return ok({
      options: opts.value,
      fingerprint: p.value.fingerprint,
      days: p.value.days,
      placed: p.value.placed.map((x) => ({ groupId: x.groupId, label: label.get(x.groupId) ?? "", subject: { id: x.subjectId, name: x.subjectName, color: x.subjectColor }, teacherName: x.teacherName, day: x.day, startsAt: x.startsAt, endsAt: x.endsAt, warnings: x.warnings })),
      unplaced: p.value.unplaced.map((x) => ({ groupId: x.groupId, label: label.get(x.groupId) ?? "", subjectName: x.subjectName, reason: x.reason })),
      kept: p.value.kept.map((e) => examDto(e, ctx.groups)),
      removed: p.value.removed.length,
    });
  }

  /** Aplica a proposta que se viu (se os dados mudaram entretanto, não grava: mostra-se a nova). Fica em preparação. */
  async applyProposal(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, seasonId: string, input: GenerateOptions, fingerprint: string): R<{ created: number; removed: number; unplaced: number }> {
    if (!actor.canGenerate) return fail(examError("FORBIDDEN", "Não tem permissão para gerar o calendário de provas."));
    const opts = checkOptions(input);
    if (!opts.ok) return opts;
    const today = this.today(timeZone);
    const r = await repo.uniqueOr(() =>
      this.within(repo, seasonId, async (tx, ctx, s): R<{ created: number; removed: number; unplaced: number }> => {
        const choices = await tx.choices(ctx.year.id);
        const p = this.propose(ctx, s, choices, opts.value, today);
        if (!p.ok) return p;
        const { placed, removed, unplaced } = p.value;
        if (p.value.fingerprint !== fingerprint) return fail(examError("PROPOSAL_CHANGED", "O horário, as provas ou a configuração mudaram entretanto. Veja a nova proposta antes de a usar."));
        if (!placed.length) return fail(examError("INVALID_STATE", "A proposta não tem provas para marcar."));
        const now = this.clock.now();
        if (removed.length) await tx.removeMany(removed.map((e) => e.id));
        await tx.insert(
          placed.map((x) => ({ id: this.ids.next(), seasonId, groupId: x.groupId, subjectId: x.subjectId, teacherId: x.teacherId, day: x.day, startsAt: x.startsAt, endsAt: x.endsAt, room: null, format: s.format, notes: null, source: "AUTOMATIC" as const })),
          actor.id,
          now,
        );
        const label = new Map(ctx.groups.map((g) => [g.id, g.label]));
        await tx.record(
          "EXAM_GENERATED",
          seasonId,
          actor.id,
          {
            after: { marcadas: placed.length, substituídas: removed.length, "por marcar": unplaced.length, modo: MODE_LABELS[opts.value.mode] },
            options: opts.value,
            // o que havia e o que ficou: para se poder consultar mais tarde
            removedExams: removed.map((e) => placedText(e, label.get(e.groupId) ?? "")),
            createdExams: placed.map((x) => placedText(x, label.get(x.groupId) ?? "")),
          },
          now,
        );
        return ok({ created: placed.length, removed: removed.length, unplaced: unplaced.length });
      }),
    );
    return r ?? fail(examError("PROPOSAL_CHANGED", "Entretanto foram marcadas outras provas. Veja a nova proposta."));
  }

  /** Quantos dias há para provas com estes dias da semana (para ajudar a escolher as regras). */
  availableDays(ctx: YearCtx, s: SeasonCtx, today: string) {
    return examDays(ctx, s, [1, 2, 3, 4, 5, 6], today);
  }

  // ============================================================ publicar

  async publish(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, id: string, confirm: boolean): R<{ published: true; exams: number }> {
    if (!actor.canPublish) return fail(examError("FORBIDDEN", "Não tem permissão para publicar o calendário de provas."));
    const today = this.today(timeZone);
    return this.within(repo, id, async (tx, ctx, s): R<{ published: true; exams: number }> => {
      if (s.status === "PUBLISHED") return fail(examError("INVALID_STATE", "O calendário já está publicado."));
      if (!s.startsOn || !s.endsOn) return fail(examError("INVALID_STATE", "Configure primeiro a época: datas, turmas e disciplinas."));
      if (today > s.endsOn) return fail(examError("INVALID_STATE", "As datas desta época já passaram: altere-as para publicar."));
      const exams = ctx.exams.filter((e) => e.seasonId === id && e.status === "SCHEDULED");
      if (!exams.length) return fail(examError("INVALID_STATE", "Ainda não há provas marcadas nesta época."));
      const problems = this.problems(ctx, s, today);
      const missing = this.missing(ctx, s);
      const conflicts: Conflict[] = problems.map(({ level, code, message, exam }) => ({ level, code, message: `${exam}: ${message}` }));
      if (missing.length) conflicts.push({ level: "WARN", code: "MISSING", message: `${missing.length === 1 ? "Falta marcar 1 prova" : `Faltam marcar ${missing.length} provas`} das turmas e disciplinas abrangidas.` });
      if (s.interrupts && s.startsOn <= today) {
        const sessions = await tx.sessionsInside(s.groupIds, s.startsOn, s.endsOn);
        conflicts.push({ level: "WARN", code: "STARTED", message: `A época já começou: as aulas destas turmas desde ${dmy(s.startsOn)} passam a contar como suspensas e as que esperam decisão no RH ficam dispensadas${sessions ? ` (as ${sessions} com presenças já registadas mantêm-se)` : ""}.` });
      }
      const g = this.gate(tidy(conflicts), confirm);
      if (!g.ok) return fail(examError(g.error.code, g.error.code === "CONFLICTS" ? "Há conflitos por resolver antes de publicar." : "Há avisos: confirme para publicar.", g.error.meta ?? undefined));
      const now = this.clock.now();
      await tx.setStatus(id, "PUBLISHED", actor.id, now);
      const dismissed = s.interrupts && s.startsOn <= today ? await tx.dismissPendings(s.groupIds, s.startsOn, s.endsOn, `Aulas suspensas: ${s.name}`, actor.id, now) : 0;
      await tx.record("EXAM_SEASON_PUBLISHED", id, actor.id, { after: { provas: exams.length, turmas: s.groupIds.length, aulas: s.interrupts ? "Interrompidas" : "Mantêm-se", ...(dismissed ? { "pendências dispensadas": dismissed } : {}) }, warnings: conflicts.length }, now);
      await tx.addNotice(
        {
          seasonId: id,
          groupIds: s.groupIds,
          subjectId: null,
          teacherIds: [],
          title: `Calendário de provas publicado: ${s.name}`,
          body: `De ${dmy(s.startsOn)} a ${dmy(s.endsOn)}. ${s.interrupts ? "Nesses dias não há aulas normais nas turmas abrangidas." : "As aulas mantêm-se."} Veja as datas, as horas e as salas.`,
        },
        now,
      );
      return ok({ published: true as const, exams: exams.length });
    });
  }

  /** Volta a pôr em preparação (só antes de começar): deixa de se ver e as aulas voltam a contar. */
  async unpublish(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, id: string, rawReason: string): R<{ unpublished: true }> {
    if (!actor.canPublish) return fail(examError("FORBIDDEN", "Não tem permissão para publicar o calendário de provas."));
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    const today = this.today(timeZone);
    return this.within(repo, id, async (tx, _ctx, s): R<{ unpublished: true }> => {
      if (s.status !== "PUBLISHED" || !s.startsOn) return fail(examError("INVALID_STATE", "O calendário não está publicado."));
      if (today >= s.startsOn) return fail(examError("INVALID_STATE", "A época já começou: altere ou cancele as provas uma a uma."));
      const now = this.clock.now();
      await tx.setStatus(id, "DRAFT", actor.id, now);
      await tx.record("EXAM_SEASON_UNPUBLISHED", id, actor.id, { reason: reason.value }, now);
      await tx.addNotice({ seasonId: id, groupIds: s.groupIds, subjectId: null, teacherIds: [], title: `Calendário de provas em revisão: ${s.name}`, body: `O calendário foi retirado para alterações. Motivo: ${reason.value}` }, now);
      return ok({ unpublished: true as const });
    });
  }

  /** Adia o fim de uma época publicada que ainda não terminou. */
  async extend(repo: PrismaExamsRepository, actor: ExamActor, timeZone: string, id: string, endsOn: string, rawReason: string): R<{ endsOn: string }> {
    if (!actor.canPublish) return fail(examError("FORBIDDEN", "Não tem permissão para publicar o calendário de provas."));
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    const today = this.today(timeZone);
    return this.within(repo, id, async (tx, ctx, s): R<{ endsOn: string }> => {
      if (s.status !== "PUBLISHED" || !s.startsOn || !s.endsOn) return fail(examError("INVALID_STATE", "O calendário não está publicado."));
      if (today > s.endsOn) return fail(examError("INVALID_STATE", "A época já terminou."));
      if (!isDay(endsOn) || endsOn <= s.endsOn) return fail(examError("INVALID_INPUT", "O novo fim tem de ser depois do atual."));
      const dates = checkDates(ctx.year, s.startsOn, endsOn);
      if (!dates.ok) return dates;
      const now = this.clock.now();
      await tx.extend(id, endsOn, now);
      await tx.record("EXAM_SEASON_EXTENDED", id, actor.id, { before: { fim: s.endsOn }, after: { fim: endsOn }, reason: reason.value }, now);
      await tx.addNotice({ seasonId: id, groupIds: s.groupIds, subjectId: null, teacherIds: [], title: `Provas até ${dmy(endsOn)}: ${s.name}`, body: `O fim passou de ${dmy(s.endsOn)} para ${dmy(endsOn)}.${s.interrupts ? " Até lá não há aulas normais nas turmas abrangidas." : ""} Motivo: ${reason.value}` }, now);
      return ok({ endsOn });
    });
  }

  // ============================================================ professor e família (só o publicado)

  async mine(repo: PrismaExamsRepository, timeZone: string, userId: string) {
    const employeeId = await repo.employeeOfUser(userId);
    if (!employeeId) return fail(examError("FORBIDDEN", "A sua conta não está ligada a um professor."));
    const [list, coordinated] = await Promise.all([repo.teacherExams(employeeId), repo.coordinatedGroupIds(employeeId)]);
    const seasons = await repo.groupSeasons([...new Set(list.map((e) => e.groupId))]);
    return ok({
      today: this.today(timeZone),
      seasons: seasons.map(({ groupIds: _g, ...s }) => s),
      exams: list.map((e) => ({ ...publicDto(e), responsible: e.teacherId === employeeId, coordinates: coordinated.has(e.groupId) })),
    });
  }

  async group(repo: PrismaExamsRepository, timeZone: string, groupId: string) {
    const [list, seasons] = await Promise.all([repo.groupExams(groupId), repo.groupSeasons([groupId])]);
    return { today: this.today(timeZone), seasons: seasons.map(({ groupIds: _g, ...s }) => s), exams: list.map(publicDto) };
  }
}
