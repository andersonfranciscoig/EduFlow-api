import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Shift, YearStatus } from "../domain/academic";
import type { ClassRow, GroupRow, PedagogyRepository, WriteOutcome, YearRow, YearSummaryRow } from "../application/ports";

type Tx = Prisma.TransactionClient;
/** Chave do bloqueio consultivo que serializa as escritas nos anos letivos. */
const YEARS_LOCK = 7_200_401;

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

const toYear = (y: { id: string; name: string; startsOn: Date; endsOn: Date; status: string; activatedAt: Date | null; closedAt: Date | null; createdAt: Date }): YearRow => ({
  id: y.id,
  name: y.name,
  startsOn: y.startsOn,
  endsOn: y.endsOn,
  status: y.status as YearStatus,
  activatedAt: y.activatedAt,
  closedAt: y.closedAt,
  createdAt: y.createdAt,
});

const toGroup = (g: { id: string; classId: string; academicYearId: string; name: string; shift: string; room: string | null; capacity: number | null }): GroupRow => ({
  id: g.id,
  classId: g.classId,
  academicYearId: g.academicYearId,
  name: g.name,
  shift: g.shift as Shift,
  room: g.room,
  capacity: g.capacity,
});

/** Ordem natural das turmas: A, B, … Z, A1… */
const byName = (a: GroupRow, b: GroupRow) => a.name.localeCompare(b.name, "pt", { numeric: true });

export class PrismaPedagogyRepository implements PedagogyRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Há outro ano letivo com datas que se cruzam com [startsOn, endsOn]? */
  private async overlaps(tx: Tx, startsOn: Date, endsOn: Date, exceptId?: string) {
    const clash = await tx.academicYear.findFirst({
      where: { startsOn: { lte: endsOn }, endsOn: { gte: startsOn }, ...(exceptId && { id: { not: exceptId } }) },
      select: { id: true },
    });
    return !!clash;
  }

  private lock(tx: Tx) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(${YEARS_LOCK})`;
  }

  async listYears(): Promise<YearSummaryRow[]> {
    const years = await this.db.academicYear.findMany({ orderBy: { startsOn: "desc" } });
    if (!years.length) return [];
    const [classes, groups] = await Promise.all([
      this.db.schoolClass.groupBy({ by: ["academicYearId"], _count: { _all: true } }),
      this.db.classGroup.groupBy({ by: ["academicYearId"], _count: { _all: true }, _sum: { capacity: true } }),
    ]);
    const c = new Map(classes.map((x) => [x.academicYearId, x._count._all]));
    const g = new Map(groups.map((x) => [x.academicYearId, { n: x._count._all, cap: x._sum.capacity ?? 0 }]));
    return years.map((y) => ({ ...toYear(y), classes: c.get(y.id) ?? 0, groups: g.get(y.id)?.n ?? 0, capacity: g.get(y.id)?.cap ?? 0 }));
  }

  async findYear(id: string) {
    const y = await this.db.academicYear.findUnique({ where: { id } });
    return y ? toYear(y) : null;
  }

  async structure(yearId: string): Promise<ClassRow[]> {
    const classes = await this.db.schoolClass.findMany({
      where: { academicYearId: yearId },
      include: { groups: true },
      orderBy: [{ grade: "asc" }, { course: "asc" }],
    });
    return classes.map((c) => ({ id: c.id, academicYearId: c.academicYearId, grade: c.grade, course: c.course, description: c.description, groups: c.groups.map(toGroup).sort(byName) }));
  }

  async createYear(input: Parameters<PedagogyRepository["createYear"]>[0]): Promise<WriteOutcome<YearRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        await this.lock(tx);
        if (await this.overlaps(tx, input.startsOn, input.endsOn)) return { ok: false, reason: "overlap" } as const;
        const year = await tx.academicYear.create({
          data: { id: input.id, name: input.name, startsOn: input.startsOn, endsOn: input.endsOn, status: "PLANNED", createdById: input.createdById, createdAt: input.now, updatedAt: input.now },
        });
        // copiar a estrutura (classes e turmas) de outro ano — na mesma transação
        if (input.copyFromYearId) {
          const source = await tx.schoolClass.findMany({ where: { academicYearId: input.copyFromYearId }, include: { groups: true } });
          for (const c of source) {
            const classId = randomUUID();
            await tx.schoolClass.create({ data: { id: classId, academicYearId: year.id, grade: c.grade, course: c.course, description: c.description, createdAt: input.now } });
            if (c.groups.length) {
              await tx.classGroup.createMany({
                data: c.groups.map((g) => ({ id: randomUUID(), academicYearId: year.id, classId, name: g.name, shift: g.shift, room: g.room, capacity: g.capacity, createdAt: input.now, updatedAt: input.now })),
              });
            }
          }
        }
        return { ok: true, value: toYear(year) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
  }

  async updateYear(id: string, input: { name: string; startsOn: Date; endsOn: Date; now: Date }): Promise<WriteOutcome<YearRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        await this.lock(tx);
        if (await this.overlaps(tx, input.startsOn, input.endsOn, id)) return { ok: false, reason: "overlap" } as const;
        const updated = await tx.academicYear.updateMany({
          where: { id, status: { not: "CLOSED" } },
          data: { name: input.name, startsOn: input.startsOn, endsOn: input.endsOn, updatedAt: input.now },
        });
        if (!updated.count) return { ok: false, reason: "closed" } as const;
        return { ok: true, value: toYear((await tx.academicYear.findUnique({ where: { id } }))!) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
  }

  async setStatus(id: string, from: YearStatus, to: YearStatus, now: Date): Promise<WriteOutcome<YearRow>> {
    try {
      const changed = await this.db.academicYear.updateMany({
        where: { id, status: from },
        data: { status: to, updatedAt: now, ...(to === "ACTIVE" && { activatedAt: now }), ...(to === "CLOSED" && { closedAt: now }) },
      });
      if (!changed.count) return { ok: false, reason: "not_found" };
      return { ok: true, value: toYear((await this.db.academicYear.findUnique({ where: { id } }))!) };
    } catch (e) {
      // índice único parcial: só um ano ACTIVE
      if (isUnique(e)) return { ok: false, reason: "active_exists" };
      throw e;
    }
  }

  async deleteYear(id: string) {
    await this.db.academicYear.deleteMany({ where: { id, status: "PLANNED" } });
  }

  async addClass(input: Parameters<PedagogyRepository["addClass"]>[0]): Promise<WriteOutcome<ClassRow>> {
    try {
      const c = await this.db.schoolClass.create({
        data: { id: input.id, academicYearId: input.academicYearId, grade: input.grade, course: input.course, description: input.description, createdAt: input.now },
      });
      return { ok: true, value: { id: c.id, academicYearId: c.academicYearId, grade: c.grade, course: c.course, description: c.description, groups: [] } };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  async findClass(id: string) {
    const c = await this.db.schoolClass.findUnique({ where: { id }, include: { groups: true, academicYear: { select: { status: true } } } });
    if (!c) return null;
    return { id: c.id, academicYearId: c.academicYearId, grade: c.grade, course: c.course, description: c.description, groups: c.groups.map(toGroup), yearStatus: c.academicYear.status as YearStatus };
  }

  async removeClass(id: string) {
    await this.db.schoolClass.deleteMany({ where: { id, groups: { none: {} } } });
  }

  async addGroup(input: Parameters<PedagogyRepository["addGroup"]>[0]): Promise<WriteOutcome<GroupRow>> {
    try {
      const g = await this.db.classGroup.create({
        data: { id: input.id, classId: input.classId, academicYearId: input.academicYearId, name: input.name, shift: input.shift, room: input.room, capacity: input.capacity, createdAt: input.now, updatedAt: input.now },
      });
      return { ok: true, value: toGroup(g) };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  async findGroup(id: string) {
    const g = await this.db.classGroup.findUnique({ where: { id }, include: { academicYear: { select: { status: true } } } });
    return g ? { ...toGroup(g), yearStatus: g.academicYear.status as YearStatus } : null;
  }

  async updateGroup(id: string, input: { name: string; shift: Shift; room: string | null; capacity: number | null; now: Date }): Promise<WriteOutcome<GroupRow>> {
    try {
      const g = await this.db.classGroup.update({ where: { id }, data: { name: input.name, shift: input.shift, room: input.room, capacity: input.capacity, updatedAt: input.now } });
      return { ok: true, value: toGroup(g) };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  async removeGroup(id: string) {
    await this.db.classGroup.deleteMany({ where: { id } });
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
