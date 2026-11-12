import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Shift, YearStatus } from "../domain/academic";
import { effectiveVacancies, pickGroup, type ReservationStatus } from "../domain/seats";
import type { ClassRow, GroupRow, PedagogyRepository, ReservationRow, SeatOutcome, WriteOutcome, YearRow, YearSummaryRow } from "../application/ports";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;
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

const toGroup = (g: { id: string; classId: string; academicYearId: string; name: string; shift: string; room: string | null; capacity: number | null }, confirmed = 0): GroupRow => ({
  id: g.id,
  classId: g.classId,
  academicYearId: g.academicYearId,
  name: g.name,
  shift: g.shift as Shift,
  room: g.room,
  capacity: g.capacity,
  confirmed,
});

const toReservation = (r: { id: string; academicYearId: string; classId: string; groupId: string | null; status: string; reference: string; expiresAt: Date | null; createdAt: Date }): ReservationRow => ({
  id: r.id,
  academicYearId: r.academicYearId,
  classId: r.classId,
  groupId: r.groupId,
  status: r.status as ReservationStatus,
  reference: r.reference,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
});

/** Ordem natural das turmas: A, B, … Z, A1… */
const byName = (a: GroupRow, b: GroupRow) => a.name.localeCompare(b.name, "pt", { numeric: true });

/** Reservas que ocupam vaga: confirmadas, ou reservadas ainda no prazo. */
const active = (now: Date): Prisma.SeatReservationWhereInput => ({ OR: [{ status: "CONFIRMED" }, { status: "HELD", expiresAt: { gt: now } }] });

/** Contagens por classe (reservadas, confirmadas) e por turma (confirmadas). */
async function seatCounts(db: Db, where: Prisma.SeatReservationWhereInput, now: Date) {
  const rows = await db.seatReservation.groupBy({ by: ["classId", "groupId", "status"], where: { AND: [where, active(now)] }, _count: { _all: true } });
  const held = new Map<string, number>();
  const confirmedByClass = new Map<string, number>();
  const confirmedByGroup = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "HELD") held.set(r.classId, (held.get(r.classId) ?? 0) + r._count._all);
    else {
      confirmedByClass.set(r.classId, (confirmedByClass.get(r.classId) ?? 0) + r._count._all);
      if (r.groupId) confirmedByGroup.set(r.groupId, (confirmedByGroup.get(r.groupId) ?? 0) + r._count._all);
    }
  }
  return { held, confirmedByClass, confirmedByGroup };
}

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

  /**
   * Bloqueia a linha da classe e devolve o estado das vagas dela (dentro da transação).
   * Todas as escritas que mexem em vagas passam por aqui → sem corridas.
   */
  private async lockedClass(tx: Tx, classId: string, now: Date) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_classes WHERE id = ${classId}::uuid FOR UPDATE`;
    if (!locked.length) return null;
    const c = await tx.schoolClass.findUnique({ where: { id: classId }, include: { groups: true, academicYear: { select: { status: true } } } });
    if (!c) return null;
    const counts = await seatCounts(tx, { classId }, now);
    const groups = c.groups.map((g) => toGroup(g, counts.confirmedByGroup.get(g.id) ?? 0)).sort(byName);
    const capacity = groups.reduce((n, g) => n + (g.capacity ?? 0), 0);
    const held = counts.held.get(classId) ?? 0;
    const confirmed = counts.confirmedByClass.get(classId) ?? 0;
    return { cls: c, yearStatus: c.academicYear.status as YearStatus, groups, capacity, vacanciesSet: c.vacancies, held, confirmed, taken: held + confirmed };
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
    const now = new Date();
    const [classes, counts] = await Promise.all([
      this.db.schoolClass.findMany({ where: { academicYearId: yearId }, include: { groups: true }, orderBy: [{ grade: "asc" }, { course: "asc" }] }),
      seatCounts(this.db, { academicYearId: yearId }, now),
    ]);
    return classes.map((c) => ({
      id: c.id,
      academicYearId: c.academicYearId,
      grade: c.grade,
      course: c.course,
      description: c.description,
      vacanciesSet: c.vacancies,
      held: counts.held.get(c.id) ?? 0,
      groups: c.groups.map((g) => toGroup(g, counts.confirmedByGroup.get(g.id) ?? 0)).sort(byName),
    }));
  }

  async createYear(input: Parameters<PedagogyRepository["createYear"]>[0]): Promise<WriteOutcome<YearRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        await this.lock(tx);
        if (await this.overlaps(tx, input.startsOn, input.endsOn)) return { ok: false, reason: "overlap" } as const;
        const year = await tx.academicYear.create({
          data: { id: input.id, name: input.name, startsOn: input.startsOn, endsOn: input.endsOn, status: "PLANNED", createdById: input.createdById, createdAt: input.now, updatedAt: input.now },
        });
        // copiar a estrutura (classes, vagas definidas e turmas) de outro ano — na mesma transação; as reservas NÃO se copiam
        if (input.copyFromYearId) {
          const source = await tx.schoolClass.findMany({ where: { academicYearId: input.copyFromYearId }, include: { groups: true } });
          for (const c of source) {
            const classId = randomUUID();
            await tx.schoolClass.create({
              data: { id: classId, academicYearId: year.id, grade: c.grade, course: c.course, description: c.description, vacancies: c.vacancies, createdAt: input.now },
            });
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
      return { ok: true, value: { id: c.id, academicYearId: c.academicYearId, grade: c.grade, course: c.course, description: c.description, vacanciesSet: null, held: 0, groups: [] } };
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  async findClass(id: string) {
    const c = await this.db.schoolClass.findUnique({ where: { id }, include: { groups: true, academicYear: { select: { status: true } } } });
    if (!c) return null;
    const counts = await seatCounts(this.db, { classId: id }, new Date());
    return {
      id: c.id,
      academicYearId: c.academicYearId,
      grade: c.grade,
      course: c.course,
      description: c.description,
      vacanciesSet: c.vacancies,
      held: counts.held.get(id) ?? 0,
      groups: c.groups.map((g) => toGroup(g, counts.confirmedByGroup.get(g.id) ?? 0)),
      yearStatus: c.academicYear.status as YearStatus,
    };
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
    if (!g) return null;
    const confirmed = await this.db.seatReservation.count({ where: { groupId: id, status: "CONFIRMED" } });
    return { ...toGroup(g, confirmed), yearStatus: g.academicYear.status as YearStatus };
  }

  async updateGroup(id: string, input: { name: string; shift: Shift; room: string | null; capacity: number | null; now: Date }): Promise<SeatOutcome<GroupRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        const group = await tx.classGroup.findUnique({ where: { id }, select: { classId: true } });
        if (!group) return { ok: false, reason: "not_found" } as const;
        const s = await this.lockedClass(tx, group.classId, input.now);
        if (!s) return { ok: false, reason: "not_found" } as const;
        const current = s.groups.find((g) => g.id === id)!;
        // a turma nunca fica com menos lugares do que alunos
        if ((input.capacity ?? 0) < current.confirmed) return { ok: false, reason: "seats_taken", taken: current.confirmed, inGroup: current.confirmed } as const;
        // e a classe nunca fica com menos vagas do que as já tomadas (ocupadas + reservadas)
        const capacity = s.capacity - (current.capacity ?? 0) + (input.capacity ?? 0);
        if (effectiveVacancies(capacity, s.vacanciesSet) < s.taken) return { ok: false, reason: "seats_taken", taken: s.taken } as const;
        const g = await tx.classGroup.update({ where: { id }, data: { name: input.name, shift: input.shift, room: input.room, capacity: input.capacity, updatedAt: input.now } });
        return { ok: true, value: toGroup(g, current.confirmed) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  async removeGroup(id: string): Promise<SeatOutcome<void>> {
    const now = new Date();
    return this.db.$transaction(async (tx) => {
      const group = await tx.classGroup.findUnique({ where: { id }, select: { classId: true } });
      if (!group) return { ok: false, reason: "not_found" } as const;
      const s = await this.lockedClass(tx, group.classId, now);
      if (!s) return { ok: false, reason: "not_found" } as const;
      const current = s.groups.find((g) => g.id === id)!;
      if (current.confirmed > 0) return { ok: false, reason: "seats_taken", taken: current.confirmed, inGroup: current.confirmed } as const;
      if (effectiveVacancies(s.capacity - (current.capacity ?? 0), s.vacanciesSet) < s.taken) return { ok: false, reason: "seats_taken", taken: s.taken } as const;
      await tx.classGroup.delete({ where: { id } });
      return { ok: true, value: undefined } as const;
    });
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }

  // ================================================================ vagas

  async setVacancies(classId: string, value: number | null, now: Date): Promise<SeatOutcome<void>> {
    return this.db.$transaction(async (tx) => {
      const s = await this.lockedClass(tx, classId, now);
      if (!s) return { ok: false, reason: "not_found" } as const;
      if (s.yearStatus === "CLOSED") return { ok: false, reason: "closed" } as const;
      if (value !== null && value > s.capacity) return { ok: false, reason: "above_capacity", capacity: s.capacity } as const;
      if (effectiveVacancies(s.capacity, value) < s.taken) return { ok: false, reason: "seats_taken", taken: s.taken } as const;
      await tx.schoolClass.update({ where: { id: classId }, data: { vacancies: value } });
      return { ok: true, value: undefined } as const;
    });
  }

  async holdSeat(input: { id: string; classId: string; reference: string; expiresAt: Date; now: Date }): Promise<SeatOutcome<ReservationRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        const s = await this.lockedClass(tx, input.classId, input.now);
        if (!s) return { ok: false, reason: "not_found" } as const;
        if (s.yearStatus === "CLOSED") return { ok: false, reason: "closed" } as const;
        // reservas fora do prazo deixam de ocupar vaga (e libertam a referência)
        await tx.seatReservation.updateMany({ where: { classId: input.classId, status: "HELD", expiresAt: { lte: input.now } }, data: { status: "RELEASED", updatedAt: input.now } });
        const available = effectiveVacancies(s.capacity, s.vacanciesSet) - s.taken;
        if (available <= 0) return { ok: false, reason: "no_vacancy", available: 0 } as const;
        const r = await tx.seatReservation.create({
          data: { id: input.id, academicYearId: s.cls.academicYearId, classId: input.classId, status: "HELD", reference: input.reference, expiresAt: input.expiresAt, createdAt: input.now, updatedAt: input.now },
        });
        return { ok: true, value: toReservation(r) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  async confirmSeat(input: { reservationId: string; groupId: string | null; now: Date }): Promise<SeatOutcome<ReservationRow>> {
    return this.db.$transaction(async (tx) => {
      const r = await tx.seatReservation.findUnique({ where: { id: input.reservationId }, select: { classId: true } });
      if (!r) return { ok: false, reason: "not_found" } as const;
      const s = await this.lockedClass(tx, r.classId, input.now);
      if (!s) return { ok: false, reason: "not_found" } as const;
      if (s.yearStatus === "CLOSED") return { ok: false, reason: "closed" } as const;
      const current = (await tx.seatReservation.findUnique({ where: { id: input.reservationId } }))!;
      if (current.status !== "HELD") return { ok: false, reason: "not_held" } as const;
      // fora do prazo: a vaga já não lhe estava guardada — só confirma se ainda houver vaga
      if (current.expiresAt && current.expiresAt <= input.now && effectiveVacancies(s.capacity, s.vacanciesSet) - s.taken <= 0) {
        return { ok: false, reason: "no_vacancy", available: 0 } as const;
      }
      const group = pickGroup(s.groups, input.groupId);
      if (!group.ok) return { ok: false, reason: group.reason } as const;
      const updated = await tx.seatReservation.update({
        where: { id: input.reservationId },
        data: { status: "CONFIRMED", groupId: group.id, expiresAt: null, updatedAt: input.now },
      });
      return { ok: true, value: toReservation(updated) } as const;
    });
  }

  async releaseSeat(reservationId: string, now: Date): Promise<SeatOutcome<ReservationRow>> {
    const r = await this.db.seatReservation.findUnique({ where: { id: reservationId } });
    if (!r) return { ok: false, reason: "not_found" };
    const changed = await this.db.seatReservation.updateMany({ where: { id: reservationId, status: { in: ["HELD", "CONFIRMED"] } }, data: { status: "RELEASED", updatedAt: now } });
    if (!changed.count) return { ok: false, reason: "not_held" };
    return { ok: true, value: toReservation({ ...r, status: "RELEASED" }) };
  }

  async findReservation(id: string) {
    const r = await this.db.seatReservation.findUnique({ where: { id }, include: { academicYear: { select: { status: true } } } });
    return r ? { ...toReservation(r), yearStatus: r.academicYear.status as YearStatus } : null;
  }
}
