import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { effectiveVacancies, pickGroup } from "../../pedagogy/domain/seats";
import type { ClassFeeRow, ClassSeats, EnrollmentRow, EnrollmentsRepository, EnrollOutcome, GroupSeats, HoldOutcome } from "../application/enrollments-ports";
import { DEFAULT_CONFIG, type EnrollmentConfig, type EnrollmentMode, formatEnrollmentNumber } from "../domain/enrollment";

type Tx = Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);

class Abort extends Error {
  constructor(readonly reason: Extract<EnrollOutcome, { ok: false }>["reason"]) {
    super(reason);
  }
}

const ENROLLMENT_INCLUDE = {
  student: { select: { fullName: true, number: true, guardians: { where: { isPrimary: true }, select: { guardian: { select: { fullName: true } } } } } },
  application: { select: { number: true, accountId: true } },
  academicYear: { select: { name: true, startsOn: true } },
  schoolClass: { select: { grade: true, course: { select: { name: true } } } },
  group: { select: { name: true } },
} satisfies Prisma.EnrollmentInclude;

const toRow = (e: Prisma.EnrollmentGetPayload<{ include: typeof ENROLLMENT_INCLUDE }>): EnrollmentRow => ({
  id: e.id,
  number: e.number,
  studentId: e.studentId,
  studentNumber: e.student.number,
  studentName: e.student.fullName,
  applicationId: e.applicationId,
  applicationNumber: e.application?.number ?? null,
  academicYearId: e.academicYearId,
  yearName: e.academicYear.name,
  yearStart: iso(e.academicYear.startsOn),
  classId: e.classId,
  grade: e.schoolClass.grade,
  courseName: e.schoolClass.course?.name ?? null,
  groupId: e.groupId,
  groupName: e.group?.name ?? null,
  shift: e.shift as EnrollmentRow["shift"],
  status: e.status as EnrollmentRow["status"],
  byKind: e.byKind as EnrollmentRow["byKind"],
  byName: e.byName,
  exceptionReason: e.exceptionReason,
  enrolledAt: e.enrolledAt,
  guardianName: e.student.guardians[0]?.guardian.fullName ?? null,
  accountId: e.application?.accountId ?? null,
});

/** Matrículas e vagas das inscrições, na BD do PRÓPRIO colégio. */
export class PrismaEnrollmentsRepository implements EnrollmentsRepository {
  constructor(private readonly db: PrismaClient) {}

  async config(): Promise<EnrollmentConfig> {
    const c = await this.db.admissionConfig.findUnique({ where: { id: 1 } });
    return c ? { enrollmentMode: c.enrollmentMode as EnrollmentMode, numberPrefix: c.numberPrefix, numberWithYear: c.numberWithYear, numberDigits: c.numberDigits, holdDays: c.holdDays } : DEFAULT_CONFIG;
  }

  async saveConfig(cfg: EnrollmentConfig, actorId: string | null, now: Date) {
    await this.db.admissionConfig.upsert({ where: { id: 1 }, update: { ...cfg, updatedById: actorId, updatedAt: now }, create: { id: 1, ...cfg, updatedById: actorId, updatedAt: now } });
  }

  async nextSequence(academicYearId: string) {
    const c = await this.db.enrollmentCounter.findUnique({ where: { academicYearId } });
    return (c?.last ?? 0) + 1;
  }

  async enrollmentsEnd(academicYearId: string) {
    const p = await this.db.admissionPeriods.findUnique({ where: { academicYearId }, select: { enrollmentsTo: true } });
    return p?.enrollmentsTo ? iso(p.enrollmentsTo) : null;
  }

  /** Bloqueia a classe e devolve as vagas (dentro da transação). As reservas fora do prazo deixam de contar. */
  private async lockClass(tx: Tx, classId: string, now: Date) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_classes WHERE id = ${classId}::uuid FOR UPDATE`;
    if (!locked.length) return null;
    await tx.seatReservation.updateMany({ where: { classId, status: "HELD", expiresAt: { lte: now } }, data: { status: "RELEASED", updatedAt: now } });
    const c = await tx.schoolClass.findUnique({ where: { id: classId }, include: { groups: true, academicYear: { select: { status: true } } } });
    if (!c) return null;
    const res = await tx.seatReservation.groupBy({ by: ["groupId", "status"], where: { classId, status: { in: ["HELD", "CONFIRMED"] } }, _count: { _all: true } });
    const held = res.filter((r) => r.status === "HELD").reduce((n, r) => n + r._count._all, 0);
    const confirmed = res.filter((r) => r.status === "CONFIRMED").reduce((n, r) => n + r._count._all, 0);
    const groups: GroupSeats[] = c.groups
      .map((g) => ({ id: g.id, name: g.name, shift: g.shift as GroupSeats["shift"], capacity: g.capacity, confirmed: res.filter((r) => r.status === "CONFIRMED" && r.groupId === g.id).reduce((n, r) => n + r._count._all, 0) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt", { numeric: true }));
    const capacity = groups.reduce((n, g) => n + (g.capacity ?? 0), 0);
    const vacancies = effectiveVacancies(capacity, c.vacancies);
    return { cls: c, closed: c.academicYear.status === "CLOSED", groups, vacancies, held, confirmed, available: Math.max(0, vacancies - held - confirmed) };
  }

  async holdForApplication(input: { applicationId: string; classId: string; reference: string; expiresAt: Date; now: Date }): Promise<HoldOutcome> {
    return this.db.$transaction(async (tx) => {
      const s = await this.lockClass(tx, input.classId, input.now);
      if (!s) return { ok: false, reason: "not_found" } as const;
      if (s.closed) return { ok: false, reason: "year_closed" } as const;
      const app = await tx.application.findUnique({ where: { id: input.applicationId }, select: { seatReservationId: true } });
      if (app?.seatReservationId) {
        const r = await tx.seatReservation.findUnique({ where: { id: app.seatReservationId } });
        if (r && r.status === "HELD") return { ok: true, id: r.id, expiresAt: r.expiresAt ?? input.expiresAt } as const;
      }
      if (s.available <= 0) return { ok: false, reason: "no_vacancy" } as const;
      const id = randomUUID();
      await tx.seatReservation.create({ data: { id, academicYearId: s.cls.academicYearId, classId: input.classId, status: "HELD", reference: input.reference, expiresAt: input.expiresAt, createdAt: input.now, updatedAt: input.now } });
      await tx.application.update({ where: { id: input.applicationId }, data: { seatReservationId: id } });
      return { ok: true, id, expiresAt: input.expiresAt } as const;
    });
  }

  async releaseForApplication(applicationId: string, now: Date) {
    const app = await this.db.application.findUnique({ where: { id: applicationId }, select: { seatReservationId: true } });
    if (!app?.seatReservationId) return;
    await this.db.seatReservation.updateMany({ where: { id: app.seatReservationId, status: "HELD" }, data: { status: "RELEASED", updatedAt: now } });
  }

  async seats(applicationId: string, now: Date): Promise<ClassSeats | null> {
    const app = await this.db.application.findUnique({ where: { id: applicationId }, select: { classId: true, seatReservationId: true } });
    if (!app?.classId) return null;
    const c = await this.db.schoolClass.findUnique({ where: { id: app.classId }, include: { groups: true } });
    if (!c) return null;
    const active = { OR: [{ status: "CONFIRMED" }, { status: "HELD", expiresAt: { gt: now } }] } satisfies Prisma.SeatReservationWhereInput;
    const res = await this.db.seatReservation.groupBy({ by: ["groupId", "status"], where: { classId: c.id, ...active }, _count: { _all: true } });
    const held = res.filter((r) => r.status === "HELD").reduce((n, r) => n + r._count._all, 0);
    const confirmed = res.filter((r) => r.status === "CONFIRMED").reduce((n, r) => n + r._count._all, 0);
    const groups = c.groups
      .map((g) => ({ id: g.id, name: g.name, shift: g.shift as GroupSeats["shift"], capacity: g.capacity, confirmed: res.filter((r) => r.status === "CONFIRMED" && r.groupId === g.id).reduce((n, r) => n + r._count._all, 0) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt", { numeric: true }));
    const vacancies = effectiveVacancies(
      groups.reduce((n, g) => n + (g.capacity ?? 0), 0),
      c.vacancies,
    );
    const r = app.seatReservationId ? await this.db.seatReservation.findUnique({ where: { id: app.seatReservationId } }) : null;
    return {
      classId: c.id,
      vacancies,
      held,
      confirmed,
      available: Math.max(0, vacancies - held - confirmed),
      groups,
      heldForApplication: r && r.status === "HELD" ? { id: r.id, expiresAt: r.expiresAt, expired: !!r.expiresAt && r.expiresAt <= now } : null,
    };
  }

  async fees(classId: string): Promise<ClassFeeRow[]> {
    const rows = await this.db.classFee.findMany({ where: { classId, feeItem: { archivedAt: null } }, include: { feeItem: true }, orderBy: { feeItem: { position: "asc" } } });
    return rows.map((f) => ({ name: f.feeItem.name, billing: f.feeItem.billing as ClassFeeRow["billing"], appliesTo: f.feeItem.appliesTo as ClassFeeRow["appliesTo"], amount: f.amount }));
  }

  async enroll(input: Parameters<EnrollmentsRepository["enroll"]>[0]): Promise<EnrollOutcome> {
    try {
      const id = await this.db.$transaction(async (tx) => {
        // a inscrição primeiro (bloqueada): aprovada e ainda sem matrícula
        await tx.$queryRaw`SELECT id FROM applications WHERE id = ${input.applicationId}::uuid FOR UPDATE`;
        const app = await tx.application.findUnique({ where: { id: input.applicationId }, include: { enrollment: { select: { id: true } } } });
        if (!app || app.status !== "APPROVED" || !app.studentId || !app.classId || !app.academicYearId || !app.number) throw new Abort("not_approved");
        if (app.enrollment) throw new Abort("already_enrolled");
        const dup = await tx.enrollment.findFirst({ where: { studentId: app.studentId, academicYearId: app.academicYearId, status: "ACTIVE" }, select: { id: true } });
        if (dup) throw new Abort("already_enrolled");

        // a classe bloqueada: as vagas contam-se e ocupam-se aqui (sem corridas pela última vaga)
        const s = await this.lockClass(tx, app.classId, input.now);
        if (!s) throw new Abort("not_approved");
        if (s.closed) throw new Abort("year_closed");
        if (!s.groups.length) throw new Abort("no_groups");
        const mine = app.seatReservationId ? await tx.seatReservation.findUnique({ where: { id: app.seatReservationId } }) : null;
        const hasHeld = mine?.status === "HELD";
        // sem vaga guardada, precisa de uma livre (salvo exceção autorizada)
        if (!hasHeld && s.available <= 0 && !input.exceptionReason) throw new Abort("no_vacancy");

        // a turma: a pedida (com lugar) ou a de mais lugares livres; na exceção, a pedida mesmo cheia
        let groupId: string;
        if (input.exceptionReason && input.groupId && s.groups.some((g) => g.id === input.groupId)) groupId = input.groupId;
        else {
          const picked = pickGroup(s.groups, input.groupId);
          if (!picked.ok) {
            if (picked.reason === "group_full" && input.exceptionReason) groupId = input.groupId ?? s.groups[0].id;
            else throw new Abort(picked.reason);
          } else groupId = picked.id;
        }
        const group = s.groups.find((g) => g.id === groupId)!;

        let seatId: string;
        if (hasHeld) {
          seatId = mine!.id;
          await tx.seatReservation.update({ where: { id: seatId }, data: { status: "CONFIRMED", groupId, expiresAt: null, updatedAt: input.now } });
        } else {
          if (mine) await tx.seatReservation.updateMany({ where: { id: mine.id, status: "HELD" }, data: { status: "RELEASED", updatedAt: input.now } });
          seatId = randomUUID();
          await tx.seatReservation.create({ data: { id: seatId, academicYearId: app.academicYearId, classId: app.classId, groupId, status: "CONFIRMED", reference: app.number, createdAt: input.now, updatedAt: input.now } });
        }

        // n.º de matrícula do ano (a linha do contador bloqueia-se) e n.º de aluno (permanente)
        await tx.$executeRaw`INSERT INTO enrollment_counters (academic_year_id, last) VALUES (${app.academicYearId}::uuid, 0) ON CONFLICT (academic_year_id) DO NOTHING`;
        const [{ last }] = await tx.$queryRaw<{ last: number }[]>`UPDATE enrollment_counters SET last = last + 1 WHERE academic_year_id = ${app.academicYearId}::uuid RETURNING last`;
        const year = await tx.academicYear.findUnique({ where: { id: app.academicYearId }, select: { startsOn: true } });
        const number = formatEnrollmentNumber(input.cfg, iso(year!.startsOn), Number(last));
        const student = await tx.student.findUnique({ where: { id: app.studentId }, select: { number: true } });
        let studentNumber = student?.number ?? null;
        if (!studentNumber) {
          const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`SELECT nextval('student_number_seq') AS seq`;
          studentNumber = Number(seq);
        }
        await tx.student.update({ where: { id: app.studentId }, data: { number: studentNumber, status: "ENROLLED", updatedAt: input.now } });

        const eid = randomUUID();
        await tx.enrollment.create({
          data: {
            id: eid,
            number,
            studentId: app.studentId,
            applicationId: app.id,
            academicYearId: app.academicYearId,
            classId: app.classId,
            groupId,
            shift: group.shift,
            seatReservationId: seatId,
            status: "ACTIVE",
            byKind: input.by.kind,
            byId: input.by.id,
            byName: input.by.name,
            exceptionReason: input.exceptionReason,
            enrolledAt: input.now,
            createdAt: input.now,
            updatedAt: input.now,
          },
        });
        await tx.application.update({ where: { id: app.id }, data: { seatReservationId: seatId, version: { increment: 1 }, updatedAt: input.now } });
        return eid;
      });
      return { ok: true, enrollment: (await this.byId(id))! };
    } catch (e) {
      if (e instanceof Abort) return { ok: false, reason: e.reason };
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "already_enrolled" };
      throw e;
    }
  }

  async byApplication(applicationId: string) {
    const e = await this.db.enrollment.findUnique({ where: { applicationId }, include: ENROLLMENT_INCLUDE });
    return e ? toRow(e) : null;
  }

  async byId(id: string) {
    const e = await this.db.enrollment.findUnique({ where: { id }, include: ENROLLMENT_INCLUDE });
    return e ? toRow(e) : null;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
