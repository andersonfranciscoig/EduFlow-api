import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { gradeLabel, type PedagogyError, pedagogyError, SHIFT_LABELS, type Shift, SHIFTS, YEAR_STATUS_LABELS } from "../domain/academic";
import { checkCurriculum, checkPeriods, checkSubject, isWeekday, type PeriodInput, SUBJECT_COLORS, WEEKDAYS } from "../domain/timetable";
import type { Pedagogy } from "./Pedagogy";
import type { PedagogyActor } from "./ports";
import type { ClassCurriculum, SubjectOutcome, SubjectRow, TimetableOutcome, TimetableRepository } from "./timetable-ports";

const subjectDto = (s: SubjectRow) => ({
  id: s.id,
  name: s.name,
  code: s.code,
  color: s.color,
  archived: !!s.archivedAt,
  classCount: s.classCount,
  lessonCount: s.lessonCount,
});

/** Texto do professor enquanto não há o módulo de professores. */
export const NO_TEACHER = "Sem professor atribuído";

function subjectError(r: Exclude<SubjectOutcome<unknown>, { ok: true }>, input?: { code: string }, s?: SubjectRow): PedagogyError {
  switch (r.reason) {
    case "name_taken":
      return pedagogyError("SUBJECT_EXISTS", "Já existe uma disciplina com este nome.");
    case "code_taken":
      return pedagogyError("SUBJECT_EXISTS", `A sigla ${input?.code ?? ""} já é usada por outra disciplina.`);
    case "not_found":
      return pedagogyError("SUBJECT_NOT_FOUND", "Disciplina não encontrada.");
    case "in_use":
      return pedagogyError(
        "SUBJECT_IN_USE",
        `A disciplina está em ${s?.classCount ?? 0} plano${s?.classCount === 1 ? "" : "s"} curricular${s?.classCount === 1 ? "" : "es"}${s?.lessonCount ? ` e ${s.lessonCount} aula${s.lessonCount === 1 ? "" : "s"} do horário` : ""}: arquive-a em vez de a eliminar.`,
      );
  }
}

function timetableError(r: Exclude<TimetableOutcome<unknown>, { ok: true }>, names: Record<string, string> = {}): PedagogyError {
  switch (r.reason) {
    case "not_found":
      return pedagogyError("GROUP_NOT_FOUND", "Não encontrado.");
    case "closed":
      return pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura.");
    case "slot_invalid":
      return pedagogyError("SLOT_INVALID", "Esse tempo não é de aula no turno desta turma.");
    case "not_in_curriculum":
      return pedagogyError("INVALID_INPUT", "A disciplina não está no plano curricular desta classe.");
    case "weekly_limit":
      return pedagogyError("WEEKLY_LIMIT", `A disciplina já tem os ${r.limit} tempos semanais do plano nesta turma.`, { limit: r.limit });
    case "room_busy":
      return pedagogyError("ROOM_BUSY", `A sala ${r.room} já está ocupada nesse tempo (${r.by}).`, { room: r.room, by: r.by });
    case "teacher_busy":
      return pedagogyError("TEACHER_BUSY", `${r.teacher} já tem aula a essa hora (${r.by}).`, { teacher: r.teacher, by: r.by });
    case "in_lessons":
      return pedagogyError(
        "SUBJECT_IN_USE",
        `${names[r.subjectId] ?? "A disciplina"} já tem ${r.count} tempo${r.count === 1 ? "" : "s"} marcado${r.count === 1 ? "" : "s"} no horário de uma turma: retire-os do horário antes de a tirar do plano ou baixar os tempos.`,
      );
    case "period_in_use":
      return pedagogyError("PERIOD_IN_USE", `O ${r.position}.º tempo tem ${r.count} aula${r.count === 1 ? "" : "s"} marcada${r.count === 1 ? "" : "s"}: não pode ser removido nem passar a intervalo.`);
  }
}

/**
 * Disciplinas, plano curricular, tempos letivos e horários das turmas.
 * Ver: qualquer utilizador do colégio. Alterar: a direção (as mesmas regras do Pedagógico).
 */
export class Timetable {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly pedagogy: Pedagogy,
  ) {}

  private guard(actor: PedagogyActor) {
    return this.pedagogy.canManage(actor) ? ok(undefined) : fail(pedagogyError("FORBIDDEN", "Só a direção pode alterar disciplinas e horários."));
  }

  // ================================================================ disciplinas

  async listSubjects(repo: TimetableRepository, actor: PedagogyActor) {
    return { canManage: this.pedagogy.canManage(actor), colors: SUBJECT_COLORS, subjects: (await repo.listSubjects()).map(subjectDto) };
  }

  async createSubject(repo: TimetableRepository, actor: PedagogyActor, input: { name: string; code: string; color?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    // sem cor escolhida: a primeira da paleta que ainda ninguém usa (depois, a menos usada)
    let color = input.color;
    if (!color) {
      const used = (await repo.listSubjects()).map((x) => x.color);
      color = [...SUBJECT_COLORS].sort((a, b) => used.filter((u) => u === a).length - used.filter((u) => u === b).length)[0];
    }
    const s = checkSubject({ ...input, color });
    if (!s.ok) return s;
    const r = await repo.createSubject({ ...s.value, id: this.ids.next(), now: this.clock.now() });
    return r.ok ? ok(subjectDto(r.value)) : fail(subjectError(r, s.value));
  }

  async updateSubject(repo: TimetableRepository, actor: PedagogyActor, id: string, input: { name: string; code: string; color?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const s = checkSubject(input);
    if (!s.ok) return s;
    const r = await repo.updateSubject(id, { ...s.value, now: this.clock.now() });
    return r.ok ? ok(subjectDto(r.value)) : fail(subjectError(r, s.value));
  }

  async setSubjectArchived(repo: TimetableRepository, actor: PedagogyActor, id: string, archived: boolean) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const r = await repo.setSubjectArchived(id, archived, this.clock.now());
    return r.ok ? ok(subjectDto(r.value)) : fail(subjectError(r));
  }

  async deleteSubject(repo: TimetableRepository, actor: PedagogyActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const s = await repo.findSubject(id);
    if (!s) return fail(pedagogyError("SUBJECT_NOT_FOUND", "Disciplina não encontrada."));
    const r = await repo.deleteSubject(id);
    return r.ok ? ok({ deleted: true }) : fail(subjectError(r, undefined, s));
  }

  // ================================================================ plano curricular

  /** Resumo do ano: por classe, nº de disciplinas e total de tempos/semana; por turma, aulas já marcadas. */
  async yearCurricula(repo: TimetableRepository, yearId: string) {
    const [classes, groups] = await Promise.all([repo.yearCurricula(yearId), repo.yearTimetables(yearId)]);
    return { classes, groups };
  }

  private curriculumDto(c: ClassCurriculum, canManage: boolean) {
    return {
      canManage: canManage && c.cls.yearStatus !== "CLOSED",
      cls: { ...c.cls, label: gradeLabel(c.cls.grade), groups: c.cls.groups.map((g) => ({ ...g, shiftLabel: SHIFT_LABELS[g.shift] })) },
      totalWeekly: c.items.reduce((n, i) => n + i.weeklyPeriods, 0),
      items: c.items.map((i) => ({
        subject: subjectDto(i.subject),
        weeklyPeriods: i.weeklyPeriods,
        /** tempos já marcados em cada turma */
        scheduled: c.cls.groups.map((g) => ({ groupId: g.id, groupName: g.name, count: c.scheduled[i.subject.id]?.[g.id] ?? 0 })),
      })),
    };
  }

  async classCurriculum(repo: TimetableRepository, actor: PedagogyActor, classId: string) {
    const c = await repo.classCurriculum(classId);
    if (!c) return fail(pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada."));
    return ok(this.curriculumDto(c, this.pedagogy.canManage(actor)));
  }

  /** Substitui o plano da classe (disciplinas ativas do catálogo; 1–20 tempos/semana cada). */
  async setCurriculum(repo: TimetableRepository, actor: PedagogyActor, classId: string, items: { subjectId: string; weeklyPeriods: number }[]) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const checked = checkCurriculum(items);
    if (!checked.ok) return checked;
    const current = await repo.classCurriculum(classId);
    if (!current) return fail(pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada."));
    const catalog = await repo.listSubjects();
    const inPlan = new Set(current.items.map((i) => i.subject.id));
    for (const it of checked.value) {
      const s = catalog.find((x) => x.id === it.subjectId);
      if (!s) return fail(pedagogyError("SUBJECT_NOT_FOUND", "Disciplina não encontrada."));
      // arquivadas: ficam nos planos onde já estavam, mas não entram em planos novos
      if (s.archivedAt && !inPlan.has(s.id)) return fail(pedagogyError("SUBJECT_ARCHIVED", `A disciplina ${s.name} está arquivada.`));
    }
    const r = await repo.setCurriculum(classId, checked.value, this.clock.now());
    if (!r.ok) return fail(timetableError(r, Object.fromEntries(catalog.map((s) => [s.id, s.name]))));
    return ok(this.curriculumDto((await repo.classCurriculum(classId))!, true));
  }

  // ================================================================ tempos letivos

  async periods(repo: TimetableRepository, actor: PedagogyActor) {
    const now = this.clock.now();
    const shifts = await Promise.all(SHIFTS.map(async (shift) => ({ shift, label: SHIFT_LABELS[shift], periods: await repo.periods(shift, now) })));
    return { canManage: this.pedagogy.canManage(actor), shifts };
  }

  async setPeriods(repo: TimetableRepository, actor: PedagogyActor, shift: Shift, items: PeriodInput[]) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    if (!SHIFTS.includes(shift)) return fail(pedagogyError("INVALID_INPUT", "Turno inválido."));
    const checked = checkPeriods(items);
    if (!checked.ok) return checked;
    const r = await repo.setPeriods(shift, checked.value, this.clock.now());
    return r.ok ? ok({ shift, label: SHIFT_LABELS[shift], periods: r.value }) : fail(timetableError(r));
  }

  // ================================================================ horário da turma

  async groupTimetable(repo: TimetableRepository, actor: PedagogyActor, groupId: string) {
    const t = await repo.groupTimetable(groupId, this.clock.now());
    if (!t) return fail(pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada."));
    const count = (subjectId: string) => t.lessons.filter((l) => l.subjectId === subjectId).length;
    const subjects = new Map(t.curriculum.map((c) => [c.subject.id, c.subject]));
    return ok({
      canManage: this.pedagogy.canManage(actor) && t.year.status !== "CLOSED",
      year: { ...t.year, statusLabel: YEAR_STATUS_LABELS[t.year.status] },
      cls: { ...t.cls, label: gradeLabel(t.cls.grade) },
      group: { ...t.group, shiftLabel: SHIFT_LABELS[t.group.shift] },
      weekdays: WEEKDAYS,
      periods: t.periods,
      coordinator: t.group.coordinator,
      lessons: t.lessons.map((l) => {
        const s = subjects.get(l.subjectId);
        const teacher = t.teachers[l.subjectId] ?? null;
        return {
          ...l,
          subject: s ? { id: s.id, name: s.name, code: s.code, color: s.color } : null,
          teacher,
          teacherLabel: teacher?.fullName ?? NO_TEACHER,
          /** o professor tem outra aula a esta hora (onde) */
          clash: t.clashes[l.id] ?? null,
        };
      }),
      curriculum: t.curriculum.map((c) => {
        const teacher = t.teachers[c.subject.id] ?? null;
        return { subject: subjectDto(c.subject), weeklyPeriods: c.weeklyPeriods, scheduled: count(c.subject.id), teacher, teacherLabel: teacher?.fullName ?? NO_TEACHER };
      }),
      clashes: Object.keys(t.clashes).length,
      totals: { weekly: t.curriculum.reduce((n, c) => n + c.weeklyPeriods, 0), scheduled: t.lessons.length, slots: t.periods.filter((p) => p.kind === "AULA").length * WEEKDAYS.length },
    });
  }

  /** Marca uma aula num tempo (ou limpa-o com subjectId null). */
  async setLesson(repo: TimetableRepository, actor: PedagogyActor, groupId: string, input: { weekday: number; periodId: string; subjectId?: string | null; room?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    if (!isWeekday(input.weekday)) return fail(pedagogyError("SLOT_INVALID", "Escolha um dia de segunda a sexta."));
    const room = input.room?.replace(/\s+/g, " ").trim() || null;
    if (room && room.length > 40) return fail(pedagogyError("INVALID_INPUT", "O nome da sala tem no máximo 40 caracteres."));
    const r = await repo.setLesson({ id: this.ids.next(), groupId, weekday: input.weekday, periodId: input.periodId, subjectId: input.subjectId ?? null, room, now: this.clock.now() });
    if (!r.ok) return fail(timetableError(r));
    return ok({ lesson: r.value });
  }
}
