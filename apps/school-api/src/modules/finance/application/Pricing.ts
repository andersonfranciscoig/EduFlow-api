import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { gradeLabel, gradeLevel } from "../../pedagogy/domain/academic";
import {
  annualTotal,
  APPLIES_LABELS,
  BILLING_LABELS,
  checkFeeItem,
  checkFeePlan,
  checkPrices,
  type FinanceError,
  financeError,
  type LateFeeKind,
  MAX_FEE_ITEMS,
  type PriceInput,
  yearMonths,
} from "../domain/pricing";
import type { FeeItemOutcome, FeeItemRow, FinanceActor, PriceOutcome, PricingRepository } from "./ports";

const YEAR_STATUS_LABELS = { PLANNED: "A preparar", ACTIVE: "Em curso", CLOSED: "Encerrado" } as const;

const feeItemDto = (f: FeeItemRow) => ({
  id: f.id,
  name: f.name,
  billing: f.billing,
  billingLabel: BILLING_LABELS[f.billing],
  appliesTo: f.appliesTo,
  appliesLabel: APPLIES_LABELS[f.appliesTo],
  archived: !!f.archivedAt,
  priceCount: f.priceCount,
});

function feeItemError(r: Exclude<FeeItemOutcome<unknown>, { ok: true }>, f?: FeeItemRow): FinanceError {
  switch (r.reason) {
    case "name_taken":
      return financeError("FEE_ITEM_EXISTS", "Já existe uma rubrica com este nome.");
    case "not_found":
      return financeError("FEE_ITEM_NOT_FOUND", "Rubrica não encontrada.");
    case "limit":
      return financeError("FEE_ITEM_LIMIT", `O colégio pode ter no máximo ${MAX_FEE_ITEMS} rubricas.`);
    case "in_use":
      return financeError(
        "FEE_ITEM_IN_USE",
        `A rubrica tem ${f?.priceCount ?? 0} preço${f?.priceCount === 1 ? "" : "s"} definido${f?.priceCount === 1 ? "" : "s"}: arquive-a em vez de a eliminar.`,
      );
  }
}

function priceError(r: Exclude<PriceOutcome, { ok: true }>): FinanceError {
  switch (r.reason) {
    case "not_found":
      return financeError("YEAR_NOT_FOUND", "Ano letivo não encontrado.");
    case "closed":
      return financeError("YEAR_CLOSED", "Este ano letivo está encerrado: o preçário é só de leitura.");
    case "class_mismatch":
      return financeError("CLASS_NOT_FOUND", "Uma das classes não pertence a este ano letivo.");
    case "item_missing":
      return financeError("FEE_ITEM_NOT_FOUND", "Rubrica não encontrada.");
    case "item_archived":
      return financeError("FEE_ITEM_ARCHIVED", "Uma das rubricas está arquivada: não recebe preços novos.");
  }
}

/**
 * Preçário: rubricas de cobrança, preço de cada rubrica por classe (e curso, no II Ciclo)
 * e calendário das propinas do ano. Ver: qualquer utilizador do colégio. Alterar: a direção.
 */
export class Pricing {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  canManage(actor: FinanceActor) {
    if (actor.support) return actor.support.mode === "WRITE";
    return actor.isOwner || actor.role === "DIRETOR";
  }

  private guard(actor: FinanceActor) {
    return this.canManage(actor) ? ok(undefined) : fail(financeError("FORBIDDEN", "Só a direção pode alterar o preçário."));
  }

  private actorId(actor: FinanceActor) {
    // numa sessão de suporte o id não é de um utilizador do colégio
    return actor.support ? null : actor.id;
  }

  // ================================================================ rubricas

  async listFeeItems(repo: PricingRepository, actor: FinanceActor) {
    return { canManage: this.canManage(actor), items: (await repo.listFeeItems()).map(feeItemDto) };
  }

  async createFeeItem(repo: PricingRepository, actor: FinanceActor, input: { name: string; billing: string; appliesTo?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const f = checkFeeItem(input);
    if (!f.ok) return f;
    const r = await repo.createFeeItem({ ...f.value, id: this.ids.next(), now: this.clock.now() });
    return r.ok ? ok(feeItemDto(r.value)) : fail(feeItemError(r));
  }

  async updateFeeItem(repo: PricingRepository, actor: FinanceActor, id: string, input: { name: string; billing: string; appliesTo?: string | null }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const f = checkFeeItem(input);
    if (!f.ok) return f;
    const r = await repo.updateFeeItem(id, { ...f.value, now: this.clock.now() });
    return r.ok ? ok(feeItemDto(r.value)) : fail(feeItemError(r));
  }

  async setFeeItemArchived(repo: PricingRepository, actor: FinanceActor, id: string, archived: boolean) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const r = await repo.setFeeItemArchived(id, archived, this.clock.now());
    return r.ok ? ok(feeItemDto(r.value)) : fail(feeItemError(r));
  }

  async deleteFeeItem(repo: PricingRepository, actor: FinanceActor, id: string) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const current = (await repo.listFeeItems()).find((f) => f.id === id);
    if (!current) return fail(financeError("FEE_ITEM_NOT_FOUND", "Rubrica não encontrada."));
    const r = await repo.deleteFeeItem(id);
    return r.ok ? ok({ deleted: true }) : fail(feeItemError(r, current));
  }

  // ================================================================ preçário do ano

  /** Tudo o que o ecrã do preçário precisa: rubricas, calendário e classes (com curso) do ano, com preços e totais. */
  async yearPricing(repo: PricingRepository, actor: FinanceActor, yearId: string) {
    const year = await repo.findYear(yearId);
    if (!year) return fail(financeError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    const [items, classes, stored] = await Promise.all([repo.listFeeItems(), repo.yearPricing(yearId), repo.feePlan(yearId)]);
    const available = yearMonths(year.startsOn, year.endsOn);
    const plan = stored
      ? { months: stored.months, dueDay: stored.dueDay, lateFee: { kind: stored.lateFeeKind, value: stored.lateFeeValue }, saved: true }
      : { months: available, dueDay: 10, lateFee: { kind: "NONE" as LateFeeKind, value: 0 }, saved: false };
    // rubricas ativas + arquivadas que ainda têm preço neste ano
    const used = new Set(classes.flatMap((c) => Object.keys(c.prices)));
    const shown = items.filter((f) => !f.archivedAt || used.has(f.id));
    const byId = new Map(items.map((f) => [f.id, f]));
    const monthly = shown.filter((f) => f.billing === "MENSAL");

    return ok({
      canManage: this.canManage(actor) && year.status !== "CLOSED",
      year: { id: year.id, name: year.name, status: year.status, statusLabel: YEAR_STATUS_LABELS[year.status] },
      availableMonths: available,
      plan,
      items: shown.map(feeItemDto),
      classes: classes.map((c) => {
        const priced = Object.entries(c.prices).flatMap(([feeItemId, amount]) => {
          const f = byId.get(feeItemId);
          return f ? [{ billing: f.billing, appliesTo: f.appliesTo, amount }] : [];
        });
        return {
          id: c.id,
          grade: c.grade,
          label: gradeLabel(c.grade),
          level: gradeLevel(c.grade),
          courseId: c.courseId,
          course: c.course,
          courseCode: c.courseCode,
          groups: c.groups,
          prices: c.prices,
          /** rubricas ativas ainda sem preço nesta classe */
          missing: shown.filter((f) => !f.archivedAt && c.prices[f.id] === undefined).length,
          /** propina(s) mensal(is) somadas */
          monthly: monthly.reduce((n, f) => n + (c.prices[f.id] ?? 0), 0),
          totals: { novos: annualTotal(priced, plan.months.length, "NOVOS"), continuantes: annualTotal(priced, plan.months.length, "CONTINUANTES") },
        };
      }),
    });
  }

  async setPrices(repo: PricingRepository, actor: FinanceActor, yearId: string, items: PriceInput[]) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const checked = checkPrices(items);
    if (!checked.ok) return checked;
    const now = this.clock.now();
    const r = await repo.setPrices({ yearId, items: checked.value, actorId: this.actorId(actor), now });
    if (!r.ok) return fail(priceError(r));
    if (r.value.changed) await repo.record("FINANCE_PRICES_SET", yearId, this.actorId(actor), { changed: r.value.changed }, now);
    return ok(r.value);
  }

  async copyPrices(repo: PricingRepository, actor: FinanceActor, yearId: string, fromYearId: string, overwrite: boolean) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    if (yearId === fromYearId) return fail(financeError("INVALID_INPUT", "Escolha outro ano letivo para copiar."));
    const now = this.clock.now();
    const r = await repo.copyPrices({ yearId, fromYearId, overwrite, actorId: this.actorId(actor), now });
    if (!r.ok) return fail(priceError(r));
    if (r.value.changed) await repo.record("FINANCE_PRICES_COPIED", yearId, this.actorId(actor), { fromYearId, changed: r.value.changed, overwrite }, now);
    return ok(r.value);
  }

  async setFeePlan(repo: PricingRepository, actor: FinanceActor, yearId: string, input: { months: string[]; dueDay: number; lateFee: { kind: LateFeeKind; value: number } }) {
    const allowed = this.guard(actor);
    if (!allowed.ok) return allowed;
    const year = await repo.findYear(yearId);
    if (!year) return fail(financeError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (year.status === "CLOSED") return fail(financeError("YEAR_CLOSED", "Este ano letivo está encerrado: o preçário é só de leitura."));
    const checked = checkFeePlan(input, yearMonths(year.startsOn, year.endsOn));
    if (!checked.ok) return checked;
    const now = this.clock.now();
    const saved = await repo.setFeePlan(yearId, checked.value, this.actorId(actor), now);
    await repo.record("FINANCE_FEE_PLAN_SET", yearId, this.actorId(actor), { months: saved.months.length, dueDay: saved.dueDay, lateFee: saved.lateFeeKind }, now);
    return ok({ months: saved.months, dueDay: saved.dueDay, lateFee: { kind: saved.lateFeeKind, value: saved.lateFeeValue }, saved: true });
  }
}
