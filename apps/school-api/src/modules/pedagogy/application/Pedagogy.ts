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
import type { ClassRow, GroupRow, PedagogyActor, PedagogyRepository, WriteOutcome, YearRow, YearSummaryRow } from "./ports";

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

const groupDto = (g: GroupRow) => ({ id: g.id, classId: g.classId, name: g.name, shift: g.shift, shiftLabel: SHIFT_LABELS[g.shift], room: g.room, capacity: g.capacity });

const classDto = (c: ClassRow) => ({
  id: c.id,
  grade: c.grade,
  label: gradeLabel(c.grade),
  level: gradeLevel(c.grade),
  course: c.course,
  description: c.description,
  groups: c.groups.map(groupDto),
  nextGroupName: nextGroupName(c.groups.map((g) => g.name)),
});

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
    return ok({ canManage: this.canManage(actor) && year.status !== "CLOSED", year: yearDto(year), classes: classes.map(classDto) });
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

  async addClass(repo: PedagogyRepository, actor: PedagogyActor, yearId: string, input: { grade: number; course?: string | null; description?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.findYear(yearId);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const cls = checkClass(input.grade, input.course ?? null, input.description ?? null);
    if (!cls.ok) return cls;
    const added = await repo.addClass({ id: this.ids.next(), academicYearId: yearId, ...cls.value, now: this.clock.now() });
    if (!added.ok && added.reason === "duplicate") {
      return fail(pedagogyError("CLASS_EXISTS", `A ${gradeLabel(cls.value.grade)}${cls.value.course ? ` de ${cls.value.course}` : ""} já existe neste ano letivo.`));
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
    const r = outcome(updated);
    return r.ok ? ok(groupDto(r.value)) : r;
  }

  async removeGroup(repo: PedagogyRepository, actor: PedagogyActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const existing = await repo.findGroup(id);
    if (!existing) return fail(pedagogyError("GROUP_NOT_FOUND", "Turma não encontrada."));
    if (existing.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    await repo.removeGroup(id);
    return ok({ deleted: true });
  }
}
