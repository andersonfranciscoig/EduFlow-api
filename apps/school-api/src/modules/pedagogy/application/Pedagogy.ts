import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import {
  checkClass,
  checkDates,
  checkGroup,
  cleanName,
  formatDay,
  gradeLabel,
  gradeLevel,
  nextGroupName,
  parseDay,
  type PedagogyError,
  pedagogyError,
  SHIFT_LABELS,
  suggestYearName,
  YEAR_STATUS_LABELS,
} from "../domain/academic";
import { checkCourse, checkCourseGrade, COURSE_GRADES, COURSE_KIND_LABELS, suggestCode } from "../domain/courses";
import { cleanReference, HOLD_HOURS_DEFAULT, HOLD_HOURS_MAX, type SeatNumbers, seatNumbers } from "../domain/seats";
import type { ClassRow, CourseOutcome, CourseRow, GroupRow, PedagogyActor, PedagogyRepository, ReservationRow, SeatOutcome, WriteOutcome, YearRow, YearSummaryRow } from "./ports";

type R<T> = Promise<Result<T, PedagogyError>>;

const yearDto = (y: YearRow) => ({
  id: y.id,
  name: y.name,
  startsOn: formatDay(y.startsOn),
  endsOn: formatDay(y.endsOn),
  status: y.status,
  statusLabel: YEAR_STATUS_LABELS[y.status],
  activatedAt: y.activatedAt?.toISOString() ?? null,
  closedAt: y.closedAt?.toISOString() ?? null,
});

const groupDto = (g: GroupRow) => ({
  id: g.id,
  classId: g.classId,
  name: g.name,
  shift: g.shift,
  shiftLabel: SHIFT_LABELS[g.shift],
  room: g.room,
  capacity: g.capacity,
  /** alunos colocados nesta turma */
  confirmed: g.confirmed,
  /** lugares livres (null = turma sem lotação) */
  free: g.capacity === null ? null : Math.max(0, g.capacity - g.confirmed),
  coordinator: g.coordinator,
  /** aulas já marcadas no horário (0 = ainda sem horário) */
  scheduled: g.scheduled,
});

const classDto = (c: ClassRow) => ({
  id: c.id,
  grade: c.grade,
  label: gradeLabel(c.grade),
  level: gradeLevel(c.grade),
  courseId: c.courseId,
  course: c.course,
  courseCode: c.courseCode,
  description: c.description,
  groups: c.groups.map(groupDto),
  nextGroupName: nextGroupName(c.groups.map((g) => g.name)),
  seats: seatNumbers(
    c.groups.map((g) => g.capacity),
    c.vacanciesSet,
    c.held,
    c.groups.reduce((n, g) => n + g.confirmed, 0),
  ),
});

const reservationDto = (r: ReservationRow) => ({
  id: r.id,
  classId: r.classId,
  groupId: r.groupId,
  status: r.status,
  reference: r.reference,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

const classTitle = (c: { grade: number; course: string | null }) => `${gradeLabel(c.grade)}${c.course ? ` de ${c.course}` : ""}`;

const courseDto = (c: CourseRow) => ({
  id: c.id,
  name: c.name,
  code: c.code,
  kind: c.kind,
  kindLabel: COURSE_KIND_LABELS[c.kind],
  /** classes que o tipo de curso admite (10.ª–12.ª geral; 10.ª–13.ª técnico) */
  grades: COURSE_GRADES[c.kind],
  description: c.description,
  archived: !!c.archivedAt,
  archivedAt: c.archivedAt?.toISOString() ?? null,
  /** classes que usam o curso, em todos os anos */
  classCount: c.classCount,
});

const ZERO_SEATS: SeatNumbers = { capacity: 0, groupsWithoutCapacity: 0, vacanciesSet: null, vacancies: 0, held: 0, confirmed: 0, taken: 0, available: 0 };
const addSeats = (a: SeatNumbers, b: SeatNumbers): SeatNumbers => ({
  capacity: a.capacity + b.capacity,
  groupsWithoutCapacity: a.groupsWithoutCapacity + b.groupsWithoutCapacity,
  vacanciesSet: null,
  vacancies: a.vacancies + b.vacancies,
  held: a.held + b.held,
  confirmed: a.confirmed + b.confirmed,
  taken: a.taken + b.taken,
  available: a.available + b.available,
});

function courseError(r: Exclude<CourseOutcome<unknown>, { ok: true }>, input?: { code: string | null }, what: "update" | "delete" = "update", classCount = 0): PedagogyError {
  switch (r.reason) {
    case "name_taken":
      return pedagogyError("COURSE_EXISTS", "Já existe um curso com este nome.");
    case "code_taken":
      return pedagogyError("COURSE_EXISTS", `A sigla ${input?.code ?? ""} já é usada por outro curso.`);
    case "not_found":
      return pedagogyError("COURSE_NOT_FOUND", "Curso não encontrado.");
    case "in_use":
      return what === "delete"
        ? pedagogyError("COURSE_IN_USE", `O curso tem ${classCount} classe${classCount === 1 ? "" : "s"} (neste ou noutros anos): arquive-o em vez de o eliminar.`)
        : pedagogyError("COURSE_IN_USE", "O curso tem classes de 13.ª: não pode passar a ensino geral (10.ª a 12.ª).");
  }
}

/** Traduz um "não deu" das escritas de vagas para um erro de domínio com mensagem clara. */
function seatError(
  r: Exclude<SeatOutcome<unknown>, { ok: true }>,
  ctx: { cls?: { grade: number; course: string | null }; groupName?: string; what: "class" | "group" | "reservation"; removing?: boolean },
): PedagogyError {
  const name = ctx.cls ? classTitle(ctx.cls) : "classe";
  switch (r.reason) {
    case "no_vacancy":
      return pedagogyError("NO_VACANCY", `Não há vagas disponíveis na ${name}.`, { available: 0 });
    case "group_full":
      return pedagogyError("GROUP_FULL", ctx.groupName ? `A turma ${ctx.groupName} está lotada.` : `As turmas da ${name} estão lotadas.`);
    case "invalid_group":
      return pedagogyError("INVALID_INPUT", "Essa turma não pertence a esta classe.");
    case "seats_taken":
      if (r.inGroup !== undefined) {
        const alunos = `${r.inGroup} aluno${r.inGroup === 1 ? "" : "s"}`;
        return pedagogyError("SEATS_TAKEN", ctx.removing ? `A turma tem ${alunos}: não pode ser removida.` : `A turma tem ${alunos}: a lotação não pode ficar abaixo disso.`, { taken: r.taken });
      }
      return pedagogyError(
        "SEATS_TAKEN",
        `Há ${r.taken} vaga${r.taken === 1 ? "" : "s"} ocupada${r.taken === 1 ? "" : "s"} ou reservada${r.taken === 1 ? "" : "s"} na ${name}: ${ctx.removing ? "as restantes turmas não chegam para elas" : "as vagas não podem ficar abaixo disso"}.`,
        { taken: r.taken },
      );
    case "above_capacity":
      return pedagogyError("INVALID_INPUT", `As turmas da ${name} têm ${r.capacity} lugares: as vagas não podem passar disso.`, { capacity: r.capacity });
    case "duplicate":
      return ctx.what === "reservation"
        ? pedagogyError("RESERVATION_EXISTS", `Esta inscrição já tem uma vaga na ${name}.`)
        : pedagogyError("GROUP_EXISTS", "Já existe uma turma com este nome nesta classe.");
    case "not_held":
      return pedagogyError("INVALID_STATE", "Esta reserva já foi confirmada ou libertada.");
    case "closed":
      return pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura.");
    case "not_found":
      return ctx.what === "reservation"
        ? pedagogyError("RESERVATION_NOT_FOUND", "Reserva de vaga não encontrada.")
        : ctx.what === "group"
          ? pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada.")
          : pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada.");
  }
}

/** Traduz um "não deu" da BD (regras atómicas) para um erro de domínio. */
function outcome<T>(r: WriteOutcome<T>): Result<T, PedagogyError> {
  if (r.ok) return ok(r.value);
  const errors = {
    overlap: pedagogyError("YEAR_OVERLAP", "As datas sobrepõem-se a outro ano letivo."),
    name_taken: pedagogyError("YEAR_NAME_TAKEN", "Já existe um ano letivo com este nome."),
    active_exists: pedagogyError("ACTIVE_YEAR_EXISTS", "Já há um ano letivo em curso. Encerre-o antes de ativar outro."),
    duplicate: pedagogyError("CLASS_EXISTS", "Já existe."),
    not_found: pedagogyError("YEAR_NOT_FOUND", "Não encontrado."),
    closed: pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."),
  } as const;
  return fail(errors[r.reason]);
}

/**
 * Área pedagógica do colégio. Gerem: diretor e responsável (e o suporte EduFlow
 * em modo de edição). Os outros utilizadores (secretaria, professores) só veem.
 */
export class Pedagogy {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  canManage(actor: PedagogyActor) {
    if (actor.support) return actor.support.mode === "WRITE";
    return actor.isOwner || actor.role === "DIRETOR";
  }

  private guard(actor: PedagogyActor): Result<void, PedagogyError> {
    return this.canManage(actor) ? ok(undefined) : fail(pedagogyError("FORBIDDEN", "Só a direção pode alterar o ano letivo, as classes e as turmas."));
  }

  // ================================================================ anos letivos

  async listYears(repo: PedagogyRepository, actor: PedagogyActor) {
    const years = await repo.listYears();
    return {
      canManage: this.canManage(actor),
      active: years.find((y) => y.status === "ACTIVE")?.id ?? null,
      years: years.map((y: YearSummaryRow) => ({ ...yearDto(y), classes: y.classes, groups: y.groups, capacity: y.capacity })),
    };
  }

  async year(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const year = await repo.findYear(id);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    const classes = await repo.structure(id);
    return ok({
      canManage: this.canManage(actor) && year.status !== "CLOSED",
      /** pode reservar/confirmar vagas (inscrições) */
      canEnroll: this.canEnroll(actor) && year.status !== "CLOSED",
      year: yearDto(year),
      classes: classes.map(classDto),
    });
  }

  async createYear(
    repo: PedagogyRepository,
    actor: PedagogyActor,
    input: { name?: string | null; startsOn: string; endsOn: string; copyFromYearId?: string | null },
  ): R<ReturnType<typeof yearDto>> {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const startsOn = parseDay(input.startsOn);
    const endsOn = parseDay(input.endsOn);
    if (!startsOn || !endsOn) return fail(pedagogyError("INVALID_DATES", "Indique datas válidas (início e fim)."));
    const dates = checkDates(startsOn, endsOn);
    if (!dates.ok) return dates;
    const name = cleanName(input.name?.trim() || suggestYearName(startsOn, endsOn));
    if (!name.ok) return name;
    if (input.copyFromYearId && !(await repo.findYear(input.copyFromYearId))) {
      return fail(pedagogyError("YEAR_NOT_FOUND", "O ano letivo a copiar não existe."));
    }

    const now = this.clock.now();
    const created = outcome(
      await repo.createYear({ id: this.ids.next(), name: name.value, startsOn, endsOn, createdById: actor.support ? null : actor.id, copyFromYearId: input.copyFromYearId ?? null, now }),
    );
    if (!created.ok) return created;
    await repo.record("ACADEMIC_YEAR_CREATED", created.value.id, actor.support ? null : actor.id, { name: name.value, copiedFrom: input.copyFromYearId ?? null }, now);
    return ok(yearDto(created.value));
  }

  async updateYear(repo: PedagogyRepository, actor: PedagogyActor, id: string, input: { name: string; startsOn: string; endsOn: string }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.findYear(id);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const startsOn = parseDay(input.startsOn);
    const endsOn = parseDay(input.endsOn);
    if (!startsOn || !endsOn) return fail(pedagogyError("INVALID_DATES", "Indique datas válidas (início e fim)."));
    const dates = checkDates(startsOn, endsOn);
    if (!dates.ok) return dates;
    const name = cleanName(input.name);
    if (!name.ok) return name;
    const updated = outcome(await repo.updateYear(id, { name: name.value, startsOn, endsOn, now: this.clock.now() }));
    return updated.ok ? ok(yearDto(updated.value)) : updated;
  }

  /** PLANNED → ACTIVE (só um ano em curso). */
  async activate(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    return this.transition(repo, actor, id, "PLANNED", "ACTIVE", "ACADEMIC_YEAR_ACTIVATED", "Só um ano a preparar pode ser ativado.");
  }

  /** ACTIVE → CLOSED (fica só de leitura). */
  async close(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    return this.transition(repo, actor, id, "ACTIVE", "CLOSED", "ACADEMIC_YEAR_CLOSED", "Só o ano em curso pode ser encerrado.");
  }

  private async transition(repo: PedagogyRepository, actor: PedagogyActor, id: string, from: "PLANNED" | "ACTIVE", to: "ACTIVE" | "CLOSED", event: string, wrong: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.findYear(id);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status !== from) return fail(pedagogyError("INVALID_STATE", wrong));
    const now = this.clock.now();
    const changed = outcome(await repo.setStatus(id, from, to, now));
    if (!changed.ok) return changed;
    await repo.record(event, id, actor.support ? null : actor.id, { name: year.name }, now);
    return ok(yearDto(changed.value));
  }

  /** Só um ano a preparar e ainda sem classes. */
  async deleteYear(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.findYear(id);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status !== "PLANNED") return fail(pedagogyError("INVALID_STATE", "Só se pode eliminar um ano letivo que ainda não começou."));
    if ((await repo.structure(id)).length) return fail(pedagogyError("INVALID_STATE", "Remova primeiro as classes deste ano letivo."));
    await repo.deleteYear(id);
    return ok({ deleted: true });
  }

  // ================================================================ classes

  async addClass(repo: PedagogyRepository, actor: PedagogyActor, yearId: string, input: { grade: number; courseId?: string | null; description?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.findYear(yearId);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const cls = checkClass(input.grade, input.courseId ?? null, input.description ?? null);
    if (!cls.ok) return cls;
    // o curso tem de existir, estar ativo e aceitar esta classe (ex.: 13.ª só no técnico-profissional)
    const course = cls.value.courseId ? await repo.findCourse(cls.value.courseId) : null;
    if (cls.value.courseId) {
      if (!course) return fail(pedagogyError("COURSE_NOT_FOUND", "Curso não encontrado."));
      if (course.archivedAt) return fail(pedagogyError("COURSE_ARCHIVED", `O curso ${course.name} está arquivado: reative-o para criar classes.`));
      const fits = checkCourseGrade(course.kind, cls.value.grade, course.name);
      if (!fits.ok) return fits;
    }
    const added = await repo.addClass({ id: this.ids.next(), academicYearId: yearId, ...cls.value, now: this.clock.now() });
    if (!added.ok && added.reason === "duplicate") {
      return fail(pedagogyError("CLASS_EXISTS", `A ${gradeLabel(cls.value.grade)}${course ? ` de ${course.name}` : ""} já existe neste ano letivo.`));
    }
    const r = outcome(added);
    return r.ok ? ok(classDto(r.value)) : r;
  }

  /** Só sem turmas (para não apagar turmas sem querer). */
  async removeClass(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const cls = await repo.findClass(id);
    if (!cls) return fail(pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada."));
    if (cls.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    if (cls.groups.length) return fail(pedagogyError("INVALID_STATE", "Remova primeiro as turmas desta classe."));
    await repo.removeClass(id);
    return ok({ deleted: true });
  }

  // ================================================================ turmas

  async addGroup(repo: PedagogyRepository, actor: PedagogyActor, classId: string, input: { name?: string | null; shift: string; room?: string | null; capacity?: number | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const cls = await repo.findClass(classId);
    if (!cls) return fail(pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada."));
    if (cls.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const group = checkGroup({ ...input, name: input.name?.trim() || nextGroupName(cls.groups.map((g) => g.name)) });
    if (!group.ok) return group;
    const added = await repo.addGroup({ id: this.ids.next(), classId, academicYearId: cls.academicYearId, ...group.value, now: this.clock.now() });
    if (!added.ok && added.reason === "duplicate") return fail(pedagogyError("GROUP_EXISTS", `A turma ${group.value.name} já existe nesta classe.`));
    const r = outcome(added);
    return r.ok ? ok(groupDto(r.value)) : r;
  }

  async updateGroup(repo: PedagogyRepository, actor: PedagogyActor, id: string, input: { name: string; shift: string; room?: string | null; capacity?: number | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const existing = await repo.findGroup(id);
    if (!existing) return fail(pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada."));
    if (existing.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const group = checkGroup(input);
    if (!group.ok) return group;
    const updated = await repo.updateGroup(id, { ...group.value, now: this.clock.now() });
    if (!updated.ok && updated.reason === "duplicate") return fail(pedagogyError("GROUP_EXISTS", `A turma ${group.value.name} já existe nesta classe.`));
    if (!updated.ok) return fail(seatError(updated, { cls: await repo.findClass(existing.classId) ?? undefined, what: "group" }));
    return ok(groupDto(updated.value));
  }

  /** Só sem alunos na turma e sem deixar a classe com menos vagas do que as já tomadas. */
  async removeGroup(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const existing = await repo.findGroup(id);
    if (!existing) return fail(pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada."));
    if (existing.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const removed = await repo.removeGroup(id);
    if (!removed.ok) return fail(seatError(removed, { cls: await repo.findClass(existing.classId) ?? undefined, what: "group", removing: true }));
    return ok({ deleted: true });
  }

  // ================================================================ vagas

  /** Quem pode reservar e confirmar vagas (inscrições): a direção e a secretaria. */
  canEnroll(actor: PedagogyActor) {
    return this.canManage(actor) || (!actor.support && actor.role === "SECRETARIA");
  }

  /** Vagas da classe (direção). null = usar os lugares das turmas. Nunca acima dos lugares nem abaixo das já tomadas. */
  async setVacancies(repo: PedagogyRepository, actor: PedagogyActor, classId: string, value: number | null) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const cls = await repo.findClass(classId);
    if (!cls) return fail(pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada."));
    if (value !== null && (!Number.isInteger(value) || value < 0)) return fail(pedagogyError("INVALID_INPUT", "Indique um número de vagas (0 ou mais)."));
    const now = this.clock.now();
    const r = await repo.setVacancies(classId, value, now);
    if (!r.ok) return fail(seatError(r, { cls, what: "class" }));
    await repo.record("CLASS_VACANCIES_SET", classId, actor.support ? null : actor.id, { class: classTitle(cls), vacancies: value }, now);
    const updated = (await repo.findClass(classId))!;
    return ok(classDto(updated));
  }

  /** Reserva uma vaga na classe (ex.: ao submeter uma inscrição). Falha se não houver vagas. */
  async holdSeat(repo: PedagogyRepository, actor: PedagogyActor, classId: string, input: { reference: string; holdHours?: number | null }) {
    if (!this.canEnroll(actor)) return fail(pedagogyError("FORBIDDEN", "Só a direção e a secretaria podem reservar vagas."));
    const cls = await repo.findClass(classId);
    if (!cls) return fail(pedagogyError("CLASS_NOT_FOUND", "Classe não encontrada."));
    if (cls.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const reference = cleanReference(input.reference);
    if (!reference) return fail(pedagogyError("INVALID_INPUT", "Indique a referência da inscrição (até 60 caracteres)."));
    const hours = input.holdHours ?? HOLD_HOURS_DEFAULT;
    if (!Number.isInteger(hours) || hours < 1 || hours > HOLD_HOURS_MAX) return fail(pedagogyError("INVALID_INPUT", `O prazo da reserva é de 1 a ${HOLD_HOURS_MAX} horas.`));
    const now = this.clock.now();
    const r = await repo.holdSeat({ id: this.ids.next(), classId, reference, expiresAt: new Date(now.getTime() + hours * 3_600_000), now });
    return r.ok ? ok(reservationDto(r.value)) : fail(seatError(r, { cls, what: "reservation" }));
  }

  /** Confirma a vaga e coloca o aluno numa turma com lugar (a pedida ou a com mais lugares livres). */
  async confirmSeat(repo: PedagogyRepository, actor: PedagogyActor, reservationId: string, input: { groupId?: string | null }) {
    if (!this.canEnroll(actor)) return fail(pedagogyError("FORBIDDEN", "Só a direção e a secretaria podem confirmar vagas."));
    const res = await repo.findReservation(reservationId);
    if (!res) return fail(pedagogyError("RESERVATION_NOT_FOUND", "Reserva de vaga não encontrada."));
    const cls = await repo.findClass(res.classId);
    const r = await repo.confirmSeat({ reservationId, groupId: input.groupId ?? null, now: this.clock.now() });
    if (!r.ok) {
      const groupName = input.groupId ? cls?.groups.find((g) => g.id === input.groupId)?.name : undefined;
      return fail(seatError(r, { cls: cls ?? undefined, groupName, what: "reservation" }));
    }
    return ok(reservationDto(r.value));
  }

  /** Liberta a vaga (inscrição desistida/recusada, ou aluno que saiu). */
  async releaseSeat(repo: PedagogyRepository, actor: PedagogyActor, reservationId: string) {
    if (!this.canEnroll(actor)) return fail(pedagogyError("FORBIDDEN", "Só a direção e a secretaria podem libertar vagas."));
    const r = await repo.releaseSeat(reservationId, this.clock.now());
    return r.ok ? ok(reservationDto(r.value)) : fail(seatError(r, { what: "reservation" }));
  }

  // ================================================================ cursos

  /**
   * Catálogo de cursos e, para o ano letivo pedido (por omissão o ano em curso ou o
   * mais recente), as classes, turmas e vagas de cada curso nesse ano.
   */
  async listCourses(repo: PedagogyRepository, actor: PedagogyActor, yearId?: string | null) {
    const [courses, years] = await Promise.all([repo.listCourses(), repo.listYears()]);
    const year = years.find((y) => y.id === yearId) ?? years.find((y) => y.status === "ACTIVE") ?? years[0] ?? null;
    const classes = year ? await repo.structure(year.id) : [];
    return {
      canManage: this.canManage(actor),
      year: year ? yearDto(year) : null,
      courses: courses.map((c) => {
        const inYear = classes.filter((k) => k.courseId === c.id).map(classDto);
        return {
          ...courseDto(c),
          year: {
            classes: inYear.map((k) => ({ id: k.id, grade: k.grade, label: k.label, groups: k.groups.length, seats: k.seats })),
            groups: inYear.reduce((n, k) => n + k.groups.length, 0),
            seats: inYear.reduce((s, k) => addSeats(s, k.seats), ZERO_SEATS),
            /** classes que o curso admite e ainda não existem neste ano */
            missingGrades: COURSE_GRADES[c.kind].filter((g) => !inYear.some((k) => k.grade === g)),
          },
        };
      }),
    };
  }

  /** Um curso com as suas classes em todos os anos letivos (turmas e vagas incluídas). */
  async course(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const course = await repo.findCourse(id);
    if (!course) return fail(pedagogyError("COURSE_NOT_FOUND", "Curso não encontrado."));
    const classes = await repo.courseClasses(id);
    const byYear = new Map<string, { year: YearRow; classes: ClassRow[] }>();
    for (const c of classes) byYear.set(c.year.id, { year: c.year, classes: [...(byYear.get(c.year.id)?.classes ?? []), c] });
    return ok({
      canManage: this.canManage(actor),
      course: courseDto(course),
      suggestedCode: course.code ?? suggestCode(course.name),
      years: [...byYear.values()].map(({ year, classes: list }) => {
        const dtos = list.map(classDto);
        return {
          year: yearDto(year),
          editable: this.canManage(actor) && year.status !== "CLOSED",
          classes: dtos,
          seats: dtos.reduce((s, k) => addSeats(s, k.seats), ZERO_SEATS),
          missingGrades: COURSE_GRADES[course.kind].filter((g) => !list.some((k) => k.grade === g)),
        };
      }),
    });
  }

  async createCourse(repo: PedagogyRepository, actor: PedagogyActor, input: { name: string; code?: string | null; kind: string; description?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const c = checkCourse(input);
    if (!c.ok) return c;
    const now = this.clock.now();
    const r = await repo.createCourse({ id: this.ids.next(), ...c.value, now });
    if (!r.ok) return fail(courseError(r, c.value));
    await repo.record("COURSE_CREATED", r.value.id, actor.support ? null : actor.id, { name: c.value.name, kind: c.value.kind }, now);
    return ok(courseDto(r.value));
  }

  /** Mudar o nome muda-o em todas as classes. Técnico → geral só sem classes de 13.ª. */
  async updateCourse(repo: PedagogyRepository, actor: PedagogyActor, id: string, input: { name: string; code?: string | null; kind: string; description?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const c = checkCourse(input);
    if (!c.ok) return c;
    const r = await repo.updateCourse(id, { ...c.value, now: this.clock.now() });
    return r.ok ? ok(courseDto(r.value)) : fail(courseError(r, c.value));
  }

  /** Arquivado: deixa de aparecer para novas classes; as existentes mantêm-no. */
  async setCourseArchived(repo: PedagogyRepository, actor: PedagogyActor, id: string, archived: boolean) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const now = this.clock.now();
    const r = await repo.setCourseArchived(id, archived, now);
    if (!r.ok) return fail(courseError(r));
    await repo.record(archived ? "COURSE_ARCHIVED" : "COURSE_RESTORED", id, actor.support ? null : actor.id, { name: r.value.name }, now);
    return ok(courseDto(r.value));
  }

  /** Só cursos que nunca tiveram classes (os outros arquivam-se). */
  async deleteCourse(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const course = await repo.findCourse(id);
    if (!course) return fail(pedagogyError("COURSE_NOT_FOUND", "Curso não encontrado."));
    const r = await repo.deleteCourse(id);
    return r.ok ? ok({ deleted: true }) : fail(courseError(r, undefined, "delete", course.classCount));
  }
}
