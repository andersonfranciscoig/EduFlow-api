import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { type AppliesTo, type Billing, type FeeItemInput, type FeePlanInput, type LateFeeKind, MAX_FEE_ITEMS, type PriceInput } from "../domain/pricing";
import type { FeeItemOutcome, FeeItemRow, FeePlanRow, PriceOutcome, PricingClass, PricingRepository, PricingYear, YearStatus } from "../application/ports";

type Tx = Prisma.TransactionClient;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const WITH_COUNT = { _count: { select: { prices: true } } } as const;
const toFeeItem = (f: { id: string; name: string; billing: string; appliesTo: string; position: number; archivedAt: Date | null; _count?: { prices: number } }): FeeItemRow => ({
  id: f.id,
  name: f.name,
  billing: f.billing as Billing,
  appliesTo: f.appliesTo as AppliesTo,
  position: f.position,
  archivedAt: f.archivedAt,
  priceCount: f._count?.prices ?? 0,
});
const toPlan = (p: { months: Prisma.JsonValue; dueDay: number; lateFeeKind: string; lateFeeValue: number; updatedAt: Date }): FeePlanRow => ({
  months: Array.isArray(p.months) ? p.months.filter((m): m is string => typeof m === "string") : [],
  dueDay: p.dueDay,
  lateFeeKind: p.lateFeeKind as LateFeeKind,
  lateFeeValue: p.lateFeeValue,
  updatedAt: p.updatedAt,
});

export class PrismaPricingRepository implements PricingRepository {
  constructor(private readonly db: PrismaClient) {}

  // ================================================================ rubricas

  async listFeeItems() {
    return (await this.db.feeItem.findMany({ include: WITH_COUNT, orderBy: [{ position: "asc" }, { createdAt: "asc" }] })).map(toFeeItem);
  }

  private async find(id: string) {
    const f = await this.db.feeItem.findUnique({ where: { id }, include: WITH_COUNT });
    return f ? toFeeItem(f) : null;
  }

  private async nameTaken(tx: Tx, name: string, exceptId?: string) {
    return !!(await tx.feeItem.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }));
  }

  async createFeeItem(input: FeeItemInput & { id: string; now: Date }): Promise<FeeItemOutcome<FeeItemRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        if (await this.nameTaken(tx, input.name)) return { ok: false, reason: "name_taken" } as const;
        const all = await tx.feeItem.aggregate({ _count: { _all: true }, _max: { position: true } });
        if (all._count._all >= MAX_FEE_ITEMS) return { ok: false, reason: "limit" } as const;
        const f = await tx.feeItem.create({
          data: { id: input.id, name: input.name, billing: input.billing, appliesTo: input.appliesTo, position: (all._max.position ?? 0) + 1, createdAt: input.now, updatedAt: input.now },
          include: WITH_COUNT,
        });
        return { ok: true, value: toFeeItem(f) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
  }

  async updateFeeItem(id: string, input: FeeItemInput & { now: Date }): Promise<FeeItemOutcome<FeeItemRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        if (!(await tx.feeItem.findUnique({ where: { id }, select: { id: true } }))) return { ok: false, reason: "not_found" } as const;
        if (await this.nameTaken(tx, input.name, id)) return { ok: false, reason: "name_taken" } as const;
        const f = await tx.feeItem.update({ where: { id }, data: { name: input.name, billing: input.billing, appliesTo: input.appliesTo, updatedAt: input.now }, include: WITH_COUNT });
        return { ok: true, value: toFeeItem(f) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
  }

  async setFeeItemArchived(id: string, archived: boolean, now: Date): Promise<FeeItemOutcome<FeeItemRow>> {
    const changed = await this.db.feeItem.updateMany({ where: { id }, data: { archivedAt: archived ? now : null, updatedAt: now } });
    if (!changed.count) return { ok: false, reason: "not_found" };
    return { ok: true, value: (await this.find(id))! };
  }

  async deleteFeeItem(id: string): Promise<FeeItemOutcome<void>> {
    try {
      const deleted = await this.db.feeItem.deleteMany({ where: { id, prices: { none: {} } } });
      if (deleted.count) return { ok: true, value: undefined };
      return (await this.db.feeItem.findUnique({ where: { id }, select: { id: true } })) ? { ok: false, reason: "in_use" } : { ok: false, reason: "not_found" };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") return { ok: false, reason: "in_use" };
      throw e;
    }
  }

  // ================================================================ preçário do ano

  async findYear(id: string): Promise<PricingYear | null> {
    const y = await this.db.academicYear.findUnique({ where: { id }, select: { id: true, name: true, startsOn: true, endsOn: true, status: true } });
    return y ? { ...y, status: y.status as YearStatus } : null;
  }

  async yearPricing(yearId: string): Promise<PricingClass[]> {
    const classes = await this.db.schoolClass.findMany({
      where: { academicYearId: yearId },
      include: { course: { select: { name: true, code: true } }, fees: { select: { feeItemId: true, amount: true } }, _count: { select: { groups: true } } },
    });
    return classes
      .map((c) => ({
        id: c.id,
        grade: c.grade,
        courseId: c.courseId,
        course: c.course?.name ?? null,
        courseCode: c.course?.code ?? null,
        groups: c._count.groups,
        prices: Object.fromEntries(c.fees.map((f) => [f.feeItemId, f.amount])),
      }))
      .sort((a, b) => a.grade - b.grade || (a.course ?? "").localeCompare(b.course ?? "", "pt"));
  }

  /** Bloqueia o ano (partilhado) para o estado não mudar a meio da escrita. */
  private async lockYear(tx: Tx, yearId: string) {
    const rows = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "academic_years" WHERE "id" = ${yearId}::uuid FOR SHARE`;
    return rows[0]?.status ?? null;
  }

  async setPrices(input: { yearId: string; items: PriceInput[]; actorId: string | null; now: Date }): Promise<PriceOutcome> {
    return this.db.$transaction(async (tx) => {
      const status = await this.lockYear(tx, input.yearId);
      if (!status) return { ok: false, reason: "not_found" } as const;
      if (status === "CLOSED") return { ok: false, reason: "closed" } as const;
      const classIds = [...new Set(input.items.map((i) => i.classId))];
      const itemIds = [...new Set(input.items.map((i) => i.feeItemId))];
      const [classes, feeItems, existing] = await Promise.all([
        tx.schoolClass.findMany({ where: { id: { in: classIds }, academicYearId: input.yearId }, select: { id: true } }),
        tx.feeItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, archivedAt: true } }),
        tx.classFee.findMany({ where: { classId: { in: classIds }, feeItemId: { in: itemIds } }, select: { classId: true, feeItemId: true, amount: true } }),
      ]);
      if (classes.length !== classIds.length) return { ok: false, reason: "class_mismatch" } as const;
      if (feeItems.length !== itemIds.length) return { ok: false, reason: "item_missing" } as const;
      const archived = new Set(feeItems.filter((f) => f.archivedAt).map((f) => f.id));
      const current = new Map(existing.map((p) => [`${p.classId}:${p.feeItemId}`, p.amount]));

      let changed = 0;
      for (const it of input.items) {
        const before = current.get(`${it.classId}:${it.feeItemId}`);
        if (it.amount === null) {
          if (before === undefined) continue;
          await tx.classFee.delete({ where: { classId_feeItemId: { classId: it.classId, feeItemId: it.feeItemId } } });
          changed++;
          continue;
        }
        if (before === it.amount) continue;
        // rubrica arquivada: mantém (e deixa corrigir) os preços que já tinha, mas não ganha novos
        if (before === undefined && archived.has(it.feeItemId)) return { ok: false, reason: "item_archived" } as const;
        await tx.classFee.upsert({
          where: { classId_feeItemId: { classId: it.classId, feeItemId: it.feeItemId } },
          create: { id: randomUUID(), academicYearId: input.yearId, classId: it.classId, feeItemId: it.feeItemId, amount: it.amount, updatedById: input.actorId, createdAt: input.now, updatedAt: input.now },
          update: { amount: it.amount, updatedById: input.actorId, updatedAt: input.now },
        });
        changed++;
      }
      return { ok: true, value: { changed } } as const;
    });
  }

  async copyPrices(input: { yearId: string; fromYearId: string; overwrite: boolean; actorId: string | null; now: Date }): Promise<PriceOutcome> {
    return this.db.$transaction(async (tx) => {
      const status = await this.lockYear(tx, input.yearId);
      if (!status) return { ok: false, reason: "not_found" } as const;
      if (status === "CLOSED") return { ok: false, reason: "closed" } as const;
      if (!(await tx.academicYear.findUnique({ where: { id: input.fromYearId }, select: { id: true } }))) return { ok: false, reason: "not_found" } as const;
      const [target, source] = await Promise.all([
        tx.schoolClass.findMany({ where: { academicYearId: input.yearId }, select: { id: true, grade: true, courseId: true, fees: { select: { feeItemId: true, amount: true } } } }),
        tx.classFee.findMany({ where: { academicYearId: input.fromYearId, feeItem: { archivedAt: null } }, select: { amount: true, feeItemId: true, schoolClass: { select: { grade: true, courseId: true } } } }),
      ]);
      // a classe equivalente no outro ano: mesma classe e mesmo curso
      const key = (grade: number, courseId: string | null) => `${grade}:${courseId ?? ""}`;
      const byKey = new Map(target.map((c) => [key(c.grade, c.courseId), c]));
      let changed = 0;
      for (const p of source) {
        const cls = byKey.get(key(p.schoolClass.grade, p.schoolClass.courseId));
        if (!cls) continue;
        const before = cls.fees.find((f) => f.feeItemId === p.feeItemId)?.amount;
        if (before === p.amount || (before !== undefined && !input.overwrite)) continue;
        await tx.classFee.upsert({
          where: { classId_feeItemId: { classId: cls.id, feeItemId: p.feeItemId } },
          create: { id: randomUUID(), academicYearId: input.yearId, classId: cls.id, feeItemId: p.feeItemId, amount: p.amount, updatedById: input.actorId, createdAt: input.now, updatedAt: input.now },
          update: { amount: p.amount, updatedById: input.actorId, updatedAt: input.now },
        });
        changed++;
      }
      return { ok: true, value: { changed } } as const;
    });
  }

  // ================================================================ calendário das propinas

  async feePlan(yearId: string) {
    const p = await this.db.feePlan.findUnique({ where: { academicYearId: yearId } });
    return p ? toPlan(p) : null;
  }

  async setFeePlan(yearId: string, plan: FeePlanInput, actorId: string | null, now: Date) {
    const data = { months: plan.months, dueDay: plan.dueDay, lateFeeKind: plan.lateFee.kind, lateFeeValue: plan.lateFee.value, updatedById: actorId, updatedAt: now };
    const p = await this.db.feePlan.upsert({ where: { academicYearId: yearId }, create: { academicYearId: yearId, ...data, createdAt: now }, update: data });
    return toPlan(p);
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
