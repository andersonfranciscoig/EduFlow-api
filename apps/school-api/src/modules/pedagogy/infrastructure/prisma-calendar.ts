import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { CalendarRepository, CalendarYearRow, ClosureRow } from "../application/calendar-ports";
import type { YearStatus } from "../domain/academic";
import type { ClosureKind, PeriodKind } from "../domain/calendar";

const closure = (c: { id: string; academicYearId: string; startsOn: Date; endsOn: Date; kind: string; reason: string; createdAt: Date }): ClosureRow => ({ ...c, kind: c.kind as ClosureKind });

export class PrismaCalendarRepository implements CalendarRepository {
  constructor(private readonly db: PrismaClient) {}

  async year(id: string): Promise<CalendarYearRow | null> {
    const y = await this.db.academicYear.findUnique({ where: { id }, select: { id: true, name: true, startsOn: true, endsOn: true, status: true, periodKind: true } });
    return y ? { ...y, status: y.status as YearStatus, periodKind: y.periodKind as PeriodKind } : null;
  }

  periods(yearId: string) {
    return this.db.academicPeriod.findMany({ where: { academicYearId: yearId }, orderBy: { position: "asc" }, select: { position: true, startsOn: true, endsOn: true } });
  }

  async closures(yearId: string) {
    const rows = await this.db.schoolClosure.findMany({ where: { academicYearId: yearId }, orderBy: { startsOn: "asc" } });
    return rows.map(closure);
  }

  async findClosure(id: string) {
    const c = await this.db.schoolClosure.findUnique({ where: { id }, include: { academicYear: { select: { status: true } } } });
    return c ? { ...closure(c), yearStatus: c.academicYear.status as YearStatus } : null;
  }

  async setPeriods(yearId: string, kind: PeriodKind, items: { position: number; startsOn: Date; endsOn: Date }[], now: Date) {
    await this.db.$transaction([
      this.db.academicPeriod.deleteMany({ where: { academicYearId: yearId } }),
      this.db.academicPeriod.createMany({ data: items.map((p) => ({ id: randomUUID(), academicYearId: yearId, ...p, createdAt: now, updatedAt: now })) }),
      this.db.academicYear.update({ where: { id: yearId }, data: { periodKind: kind, updatedAt: now } }),
    ]);
  }

  async addClosure(input: Omit<ClosureRow, "createdAt"> & { createdById: string | null; now: Date }) {
    // insere só se não se sobrepuser a outro intervalo do ano (uma instrução: sem corridas entre duas janelas)
    const n = await this.db.$executeRaw`
      INSERT INTO school_closures (id, academic_year_id, starts_on, ends_on, kind, reason, created_by_id, created_at)
      SELECT ${input.id}::uuid, ${input.academicYearId}::uuid, ${input.startsOn}::date, ${input.endsOn}::date, ${input.kind}, ${input.reason}, ${input.createdById}::uuid, ${input.now}
      WHERE NOT EXISTS (SELECT 1 FROM school_closures c WHERE c.academic_year_id = ${input.academicYearId}::uuid
                          AND c.starts_on <= ${input.endsOn}::date AND c.ends_on >= ${input.startsOn}::date)`;
    return n === 1;
  }

  async removeClosure(id: string) {
    await this.db.schoolClosure.deleteMany({ where: { id } });
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
