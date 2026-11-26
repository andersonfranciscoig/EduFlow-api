import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { formatDay, type PedagogyError, pedagogyError } from "../domain/academic";
import { CLOSURE_KINDS, checkClosure, checkPeriods, isPeriodKind, PERIOD_KINDS, type PeriodKind, periodName, suggestPeriods, weekdaysBetween } from "../domain/calendar";
import type { CalendarRepository, ClosureRow, PeriodRow } from "./calendar-ports";
import type { PedagogyActor } from "./ports";
import type { Pedagogy } from "./Pedagogy";

type R<T> = Promise<Result<T, PedagogyError>>;

const closureDto = (c: ClosureRow) => ({
  id: c.id,
  startsOn: formatDay(c.startsOn),
  endsOn: formatDay(c.endsOn),
  kind: c.kind,
  kindLabel: CLOSURE_KINDS[c.kind],
  reason: c.reason,
  weekdays: weekdaysBetween(c.startsOn, c.endsOn),
});
const periodDto = (kind: PeriodKind) => (p: PeriodRow) => ({ position: p.position, name: periodName(kind, p.position), startsOn: formatDay(p.startsOn), endsOn: formatDay(p.endsOn), weekdays: weekdaysBetween(p.startsOn, p.endsOn) });

/**
 * Calendário escolar de um ano letivo: períodos de avaliação (trimestres ou semestres) e
 * dias sem aulas. Ver: qualquer utilizador da gestão. Alterar: quem altera o ano letivo
 * (direção), e nunca num ano encerrado. Cada alteração fica na atividade (antes → depois).
 */
export class SchoolCalendar {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly pedagogy: Pedagogy,
  ) {}

  async calendar(repo: CalendarRepository, actor: PedagogyActor, yearId: string) {
    const year = await repo.year(yearId);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    const [periods, closures] = await Promise.all([repo.periods(yearId), repo.closures(yearId)]);
    const today = formatDay(this.clock.now());
    const dto = periods.map(periodDto(year.periodKind));
    return ok({
      canManage: this.pedagogy.canManage(actor) && year.status !== "CLOSED",
      year: { id: year.id, name: year.name, startsOn: formatDay(year.startsOn), endsOn: formatDay(year.endsOn), status: year.status, periodKind: year.periodKind, periodKindLabel: PERIOD_KINDS[year.periodKind].label },
      kinds: (Object.keys(PERIOD_KINDS) as PeriodKind[]).map((k) => ({ value: k, label: PERIOD_KINDS[k].label, count: PERIOD_KINDS[k].count })),
      /** sem períodos definidos: o ano ainda não está dividido (a sugestão ajuda a começar) */
      periods: dto,
      current: dto.find((p) => p.startsOn <= today && today <= p.endsOn)?.position ?? null,
      suggested: { TRIMESTRE: suggestPeriods("TRIMESTRE", year.startsOn, year.endsOn), SEMESTRE: suggestPeriods("SEMESTRE", year.startsOn, year.endsOn) },
      closureKinds: Object.entries(CLOSURE_KINDS).map(([value, label]) => ({ value, label })),
      closures: closures.map(closureDto),
    });
  }

  private async editable(repo: CalendarRepository, actor: PedagogyActor, yearId: string) {
    if (!this.pedagogy.canManage(actor)) return fail(pedagogyError("FORBIDDEN", "Só a direção pode alterar o calendário escolar."));
    const year = await repo.year(yearId);
    if (!year) return fail(pedagogyError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    return ok(year);
  }

  async setPeriods(repo: CalendarRepository, actor: PedagogyActor, yearId: string, input: { kind: string; items: { startsOn: string; endsOn: string }[] }): R<{ saved: number }> {
    const year = await this.editable(repo, actor, yearId);
    if (!year.ok) return year;
    if (!isPeriodKind(input.kind)) return fail(pedagogyError("INVALID_INPUT", "Escolha trimestres ou semestres."));
    if (input.kind !== year.value.periodKind && (await repo.yearHasGrades(yearId)))
      return fail(pedagogyError("INVALID_STATE", "Já há avaliações lançadas neste ano letivo: pode mudar as datas dos períodos, mas não passar de trimestres a semestres (ou ao contrário)."));
    const checked = checkPeriods(input.kind, year.value, input.items);
    if (!checked.ok) return checked;
    const before = await repo.periods(yearId);
    const now = this.clock.now();
    await repo.setPeriods(yearId, input.kind, checked.value, now);
    const fmt = (kind: PeriodKind, list: PeriodRow[]) => ({ kind, periods: list.map((p) => `${formatDay(p.startsOn)}→${formatDay(p.endsOn)}`) });
    await repo.record("ACADEMIC_PERIODS_SET", yearId, actor.id, { before: fmt(year.value.periodKind, before), after: fmt(input.kind, checked.value) }, now);
    return ok({ saved: checked.value.length });
  }

  async addClosure(repo: CalendarRepository, actor: PedagogyActor, yearId: string, input: { startsOn: string; endsOn?: string | null; kind: string; reason: string }) {
    const year = await this.editable(repo, actor, yearId);
    if (!year.ok) return year;
    const c = checkClosure(year.value, input);
    if (!c.ok) return c;
    const now = this.clock.now();
    const row = { id: this.ids.next(), academicYearId: yearId, ...c.value };
    if (!(await repo.addClosure({ ...row, createdById: actor.id, now })))
      return fail(pedagogyError("CLOSURE_OVERLAP", "Já há dias sem aulas marcados nessas datas."));
    await repo.record("SCHOOL_CLOSURE_ADDED", yearId, actor.id, { after: { startsOn: input.startsOn, endsOn: formatDay(c.value.endsOn), kind: c.value.kind, reason: c.value.reason } }, now);
    return ok(closureDto({ ...row, createdAt: now }));
  }

  async removeClosure(repo: CalendarRepository, actor: PedagogyActor, id: string): R<{ removed: true }> {
    if (!this.pedagogy.canManage(actor)) return fail(pedagogyError("FORBIDDEN", "Só a direção pode alterar o calendário escolar."));
    const c = await repo.findClosure(id);
    if (!c) return fail(pedagogyError("CLOSURE_NOT_FOUND", "Dias sem aulas não encontrados."));
    if (c.yearStatus === "CLOSED") return fail(pedagogyError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const now = this.clock.now();
    await repo.removeClosure(id);
    await repo.record("SCHOOL_CLOSURE_REMOVED", c.academicYearId, actor.id, { before: { startsOn: formatDay(c.startsOn), endsOn: formatDay(c.endsOn), kind: c.kind, reason: c.reason } }, now);
    return ok({ removed: true });
  }
}
