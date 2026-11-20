import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import {
  ACTION_LABELS,
  actionsFor,
  canDo,
  checkKind,
  checkReason,
  cleanText,
  dailyMirror,
  isDay,
  KIND_LABELS,
  type OccurrenceAction,
  type OccurrenceSource,
  type OccurrenceStatus,
  SOURCE_LABELS,
  STATUS_LABELS,
  todayIn,
} from "../domain/occurrences";
import { type AttendanceError, attendanceError, type AttendanceRules, TEACHER_MODELS } from "../domain/settings";
import type { NewOccurrence, OccurrenceRow, OccurrencesRepository } from "./occurrence-ports";

type R<T> = Promise<Result<T, AttendanceError>>;
export interface OccurrenceActor {
  id: string;
  canManage: boolean;
}

const PAGE_SIZE = 25;
const snapshot = (o: Pick<OccurrenceRow, "kind" | "minutesLate" | "status" | "justification">) => ({ kind: o.kind, minutesLate: o.minutesLate, status: o.status, justification: o.justification });

export const occurrenceDto = (o: OccurrenceRow) => ({
  id: o.id,
  teacher: { id: o.employeeId, fullName: o.teacherName },
  day: o.day,
  scope: o.scope,
  lesson: o.scope === "LESSON" ? { id: o.lessonId, groupName: o.groupName, subjectName: o.subjectName, startsAt: o.startsAt, endsAt: o.endsAt } : null,
  kind: o.kind,
  kindLabel: KIND_LABELS[o.kind],
  minutesLate: o.minutesLate,
  source: o.source,
  sourceLabel: SOURCE_LABELS[o.source],
  status: o.status,
  statusLabel: STATUS_LABELS[o.status],
  note: o.note,
  justification: o.justification,
  createdAt: o.createdAt.toISOString(),
  createdBy: o.createdByName,
  updatedAt: o.updatedAt.toISOString(),
});

/**
 * Faltas e atrasos dos professores (área do RH). Ver: attendance.teachers.view ·
 * marcar, justificar, alterar, anular, reabrir: attendance.teachers.manage.
 * A marcação segue o modelo do colégio: por aula (escolhem-se as aulas do horário desse dia)
 * ou por dia (uma ocorrência ao dia, que acompanha o registo diário do RH).
 * As automáticas (política do colégio) chegam com o prazo das presenças e tratam-se aqui da mesma forma.
 */
export class TeacherOccurrences {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async overview(repo: OccurrencesRepository, actor: OccurrenceActor, rules: AttendanceRules) {
    const [teachers, counts] = await Promise.all([repo.teachers(), repo.counts()]);
    return {
      canManage: actor.canManage,
      model: rules.teacherModel,
      modelLabel: TEACHER_MODELS[rules.teacherModel].label,
      procedure: rules.missingProcedure,
      today: todayIn(rules.timeZone, this.clock.now()),
      counts,
      teachers,
    };
  }

  /** O dia de um professor: as aulas do horário (modelo por aula) ou o dia (por dia), e o que já está marcado. */
  async day(repo: OccurrencesRepository, actor: OccurrenceActor, rules: AttendanceRules, employeeId: string, day: string) {
    const teacher = await repo.teacher(employeeId);
    if (!teacher) return fail(attendanceError("NOT_FOUND", "Professor não encontrado."));
    if (!isDay(day)) return fail(attendanceError("INVALID_INPUT", "Data inválida."));
    const today = todayIn(rules.timeZone, this.clock.now());
    const year = await repo.yearOn(day);
    const [closure, lessons, existing] = await Promise.all([year ? repo.closureOn(year.id, day) : null, year ? repo.lessonsOn(employeeId, year.id, day) : [], repo.onDay(employeeId, day)]);
    const active = existing.filter((o) => o.status !== "ANULADA");
    const blocked = day > today ? "Ainda não chegou este dia." : !year ? "Este dia não pertence a nenhum ano letivo." : closure ? `${closure.kindLabel}: ${closure.reason}.` : !lessons.length ? "O professor não tem aulas no horário neste dia." : null;
    return ok({
      canManage: actor.canManage && !blocked,
      teacher,
      day,
      today,
      year,
      model: rules.teacherModel,
      modelLabel: TEACHER_MODELS[rules.teacherModel].label,
      blocked,
      lessons: lessons.map((l) => ({ ...l, occurrence: (o => o && occurrenceDto(o))(active.find((o) => o.scope === "LESSON" && o.startsAt === l.startsAt)) ?? null })),
      dayOccurrence: (o => o && occurrenceDto(o))(active.find((o) => o.scope === "DAY")) ?? null,
      others: existing.filter((o) => o.status === "ANULADA").map(occurrenceDto),
    });
  }

  async mark(
    repo: OccurrencesRepository,
    actor: OccurrenceActor,
    rules: AttendanceRules,
    employeeId: string,
    input: { day: string; items: { lessonId?: string | null; kind: string; minutesLate?: number | null; note?: string | null }[] },
    source: OccurrenceSource = "MANUAL",
  ): R<{ created: number }> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para marcar faltas dos professores."));
    const plan = await this.day(repo, actor, rules, employeeId, input.day);
    if (!plan.ok) return plan;
    if (plan.value.blocked) return fail(attendanceError("NO_CLASSES", plan.value.blocked));
    if (!input.items.length) return fail(attendanceError("INVALID_INPUT", "Escolha o que marcar."));
    const now = this.clock.now();
    const out: NewOccurrence[] = [];
    if (rules.teacherModel === "PER_DAY") {
      if (input.items.length !== 1 || input.items[0].lessonId) return fail(attendanceError("INVALID_INPUT", "No modelo por dia marca-se o dia (sem aulas)."));
      const k = checkKind(input.items[0].kind, input.items[0].minutesLate);
      if (!k.ok) return k;
      out.push({ id: this.ids.next(), employeeId, day: input.day, scope: "DAY", lesson: null, ...k.value, source, note: cleanText(input.items[0].note).slice(0, 300) || null });
    } else {
      const seen = new Set<string>();
      for (const it of input.items) {
        const lesson = plan.value.lessons.find((l) => l.id === it.lessonId);
        if (!lesson) return fail(attendanceError("INVALID_INPUT", "Escolha aulas do horário do professor nesse dia."));
        if (seen.has(lesson.id)) return fail(attendanceError("INVALID_INPUT", "A mesma aula foi escolhida duas vezes."));
        seen.add(lesson.id);
        const k = checkKind(it.kind, it.minutesLate);
        if (!k.ok) return k;
        const { occurrence: _o, ...l } = lesson;
        out.push({ id: this.ids.next(), employeeId, day: input.day, scope: "LESSON", lesson: l, ...k.value, source, note: cleanText(it.note).slice(0, 300) || null });
      }
    }
    if (!(await repo.create(out, actor.id, now))) return fail(attendanceError("OCCURRENCE_EXISTS", "Já há uma ocorrência marcada para esta aula ou dia. Altere-a em vez de marcar outra."));
    for (const o of out) {
      await repo.record("TEACHER_OCCURRENCE_CREATED", o.id, actor.id, { after: { kind: o.kind, minutesLate: o.minutesLate, status: "REGISTADA", source }, reason: o.note }, now);
      if (o.scope === "DAY") await repo.mirrorDaily(employeeId, o.day, dailyMirror({ ...o, status: "REGISTADA", justification: null }), actor.id, now);
    }
    return ok({ created: out.length });
  }

  async list(repo: OccurrencesRepository, input: { employeeId?: string; status?: string; source?: string; from?: string; to?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const status = input.status && input.status in STATUS_LABELS ? (input.status as OccurrenceStatus) : undefined;
    const source = input.source && input.source in SOURCE_LABELS ? (input.source as OccurrenceSource) : undefined;
    const from = input.from && isDay(input.from) ? input.from : undefined;
    const to = input.to && isDay(input.to) ? input.to : undefined;
    const r = await repo.list({ employeeId: input.employeeId, status, source, from, to, page, pageSize: PAGE_SIZE });
    return {
      page,
      pageSize: PAGE_SIZE,
      total: r.total,
      items: r.items.map(occurrenceDto),
      statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
      sources: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
    };
  }

  async detail(repo: OccurrencesRepository, actor: OccurrenceActor, id: string) {
    const o = await repo.find(id);
    if (!o) return fail(attendanceError("NOT_FOUND", "Ocorrência não encontrada."));
    const history = await repo.history(id);
    return ok({
      canManage: actor.canManage,
      occurrence: occurrenceDto(o),
      actions: actor.canManage ? actionsFor(o.status) : [],
      history: history.map((h) => ({
        at: h.at.toISOString(),
        action: h.type.replace("TEACHER_OCCURRENCE_", ""),
        actionLabel: ACTION_LABELS[h.type.replace("TEACHER_OCCURRENCE_", "") as keyof typeof ACTION_LABELS] ?? h.type,
        by: h.actorName,
        before: h.details?.before ?? null,
        after: h.details?.after ?? null,
        reason: h.details?.reason ?? null,
      })),
    });
  }

  /** Justificar, alterar (falta ↔ atraso), anular ou reabrir — sempre com o motivo, que fica no histórico. */
  async act(
    repo: OccurrencesRepository,
    actor: OccurrenceActor,
    id: string,
    action: OccurrenceAction,
    input: { reason?: string | null; kind?: string | null; minutesLate?: number | null },
  ): R<ReturnType<typeof occurrenceDto>> {
    if (!actor.canManage) return fail(attendanceError("FORBIDDEN", "Não tem permissão para alterar faltas dos professores."));
    const o = await repo.find(id);
    if (!o) return fail(attendanceError("NOT_FOUND", "Ocorrência não encontrada."));
    const allowed = canDo(action, o.status);
    if (!allowed.ok) return allowed;
    const reason = checkReason(input.reason, action === "JUSTIFY" ? "a justificação" : "o motivo", action === "JUSTIFY" ? 500 : 300);
    if (!reason.ok) return reason;
    const before = snapshot(o);
    let after = { ...before };
    if (action === "JUSTIFY") after = { ...after, status: "JUSTIFICADA", justification: reason.value };
    if (action === "CANCEL") after = { ...after, status: "ANULADA" };
    if (action === "REOPEN") after = { ...after, status: "REGISTADA", justification: null };
    if (action === "CHANGE") {
      const k = checkKind(input.kind ?? "", input.minutesLate);
      if (!k.ok) return k;
      if (k.value.kind === o.kind && k.value.minutesLate === o.minutesLate) return fail(attendanceError("INVALID_INPUT", "Nada mudou."));
      after = { ...after, ...k.value };
    }
    const now = this.clock.now();
    if (!(await repo.update(id, after, actor.id, now))) return fail(attendanceError("OCCURRENCE_EXISTS", "Já há outra ocorrência ativa para esta aula ou dia: não é possível reabrir esta."));
    await repo.record(`TEACHER_OCCURRENCE_${{ JUSTIFY: "JUSTIFY", CHANGE: "CHANGE", CANCEL: "CANCEL", REOPEN: "REOPEN" }[action]}`, id, actor.id, { before, after, reason: reason.value }, now);
    if (o.scope === "DAY") await repo.mirrorDaily(o.employeeId, o.day, dailyMirror(after), actor.id, now);
    const fresh = await repo.find(id);
    return ok(occurrenceDto(fresh ?? o));
  }
}
