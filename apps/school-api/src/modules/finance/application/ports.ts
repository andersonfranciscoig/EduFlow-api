import type { AppliesTo, Billing, FeeItemInput, FeePlanInput, LateFeeKind, PriceInput } from "../domain/pricing";

export type YearStatus = "PLANNED" | "ACTIVE" | "CLOSED";

export interface FeeItemRow {
  id: string;
  name: string;
  billing: Billing;
  appliesTo: AppliesTo;
  position: number;
  archivedAt: Date | null;
  /** preços definidos com esta rubrica (todos os anos) */
  priceCount: number;
}

export interface PricingYear {
  id: string;
  name: string;
  startsOn: Date;
  endsOn: Date;
  status: YearStatus;
}

export interface PricingClass {
  id: string;
  grade: number;
  courseId: string | null;
  course: string | null;
  courseCode: string | null;
  groups: number;
  /** feeItemId → kwanzas */
  prices: Record<string, number>;
}

export interface FeePlanRow {
  months: string[];
  dueDay: number;
  lateFeeKind: LateFeeKind;
  lateFeeValue: number;
  updatedAt: Date;
}

export type FeeItemOutcome<T> = { ok: true; value: T } | { ok: false; reason: "name_taken" | "not_found" | "in_use" | "limit" };
export type PriceOutcome = { ok: true; value: { changed: number } } | { ok: false; reason: "not_found" | "closed" | "class_mismatch" | "item_missing" | "item_archived" };

/** Preçário — na BD do PRÓPRIO colégio. */
export interface PricingRepository {
  /** Rubricas, por posição (as de partida vêm da migração). */
  listFeeItems(): Promise<FeeItemRow[]>;
  createFeeItem(input: FeeItemInput & { id: string; now: Date }): Promise<FeeItemOutcome<FeeItemRow>>;
  updateFeeItem(id: string, input: FeeItemInput & { now: Date }): Promise<FeeItemOutcome<FeeItemRow>>;
  setFeeItemArchived(id: string, archived: boolean, now: Date): Promise<FeeItemOutcome<FeeItemRow>>;
  /** Só se nenhuma classe (de nenhum ano) tiver preço com ela. */
  deleteFeeItem(id: string): Promise<FeeItemOutcome<void>>;

  findYear(id: string): Promise<PricingYear | null>;
  /** Classes do ano com os preços de cada rubrica. */
  yearPricing(yearId: string): Promise<PricingClass[]>;
  /** Grava/retira preços (numa transação; só classes do ano; rubricas arquivadas não ganham preços novos). */
  setPrices(input: { yearId: string; items: PriceInput[]; actorId: string | null; now: Date }): Promise<PriceOutcome>;
  /** Copia os preços de outro ano para as classes equivalentes (mesma classe e curso). Só preenche o que está vazio, salvo `overwrite`. */
  copyPrices(input: { yearId: string; fromYearId: string; overwrite: boolean; actorId: string | null; now: Date }): Promise<PriceOutcome>;

  feePlan(yearId: string): Promise<FeePlanRow | null>;
  setFeePlan(yearId: string, plan: FeePlanInput, actorId: string | null, now: Date): Promise<FeePlanRow>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

/** Quem está a pedir (vem do SchoolAuthGuard). */
export interface FinanceActor {
  id: string;
  role: string;
  isOwner: boolean;
  support?: { mode: "READ" | "WRITE" };
}
