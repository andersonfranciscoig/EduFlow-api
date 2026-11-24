import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import { effectiveVacancies, pickGroup } from "../../pedagogy/domain/seats";
import type { ClassFeeRow, ClassSeats, EnrollmentRow, EnrollmentsRepository, EnrollOutcome, GroupSeats, HoldOutcome } from "../application/enrollments-ports";
import { DEFAULT_CONFIG, type EnrollmentConfig, type EnrollmentMode, formatEnrollmentNumber } from "../domain/enrollment";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;
const iso = (d: Date) => d.toISOString().slice(0, 10);

class Abort extends Error {
  constructor(readonly reason: Extract<EnrollOutcome, { ok: false }>["reason"]) {
    super(reason);
  }
}

/**
 * A matrícula como se mostra — numa só consulta (com a BD no Neon, cada ida e volta conta ~250 ms;
 * os "include" do Prisma fariam uma consulta por relação).
 */
async function loadEnrollment(db: Db, where: Prisma.Sql): Promise<EnrollmentRow | null> {
  const rows = await db.$queryRaw<
    {
      id: string;
      number: string;
      student_id: string;
      student_number: number | null;
      student_name: string;
      application_id: string | null;
      application_number: string | null;
      account_id: string | null;
      academic_year_id: string;
      year_name: string;
      starts_on: Date;
      class_id: string;
      grade: number;
      course_name: string | null;
      group_id: string | null;
      group_name: string | null;
      shift: string | null;
      status: string;
      by_kind: string;
      by_name: string | null;
      exception_reason: string | null;
      enrolled_at: Date;
      guardian_name: string | null;
    }[]
  >`
    SELECT e.id, e.number, e.student_id, s.number AS student_number, s.full_name AS student_name,
           e.application_id, a.number AS application_number, a.account_id,
           e.academic_year_id, y.name AS year_name, y.starts_on,
           e.class_id, c.grade, co.name AS course_name, e.group_id, g.name AS group_name, e.shift,
           e.status, e.by_kind, e.by_name, e.exception_reason, e.enrolled_at,
           (SELECT gu.full_name FROM student_guardians sg JOIN guardians gu ON gu.id = sg.guardian_id
             WHERE sg.student_id = e.student_id AND sg.is_primary LIMIT 1) AS guardian_name
      FROM enrollments e
      JOIN students s ON s.id = e.student_id
      JOIN academic_years y ON y.id = e.academic_year_id
      JOIN school_classes c ON c.id = e.class_id
      LEFT JOIN courses co ON co.id = c.course_id
      LEFT JOIN class_groups g ON g.id = e.group_id
      LEFT JOIN applications a ON a.id = e.application_id
     WHERE ${where}
     LIMIT 1`;
  const e = rows[0];
  if (!e) return null;
  return {
    id: e.id,
    number: e.number,
    studentId: e.student_id,
    studentNumber: e.student_number,
    studentName: e.student_name,
    applicationId: e.application_id,
    applicationNumber: e.application_number,
    academicYearId: e.academic_year_id,
    yearName: e.year_name,
    yearStart: iso(e.starts_on),
    classId: e.class_id,
    grade: e.grade,
    courseName: e.course_name,
    groupId: e.group_id,
    groupName: e.group_name,
    shift: e.shift as EnrollmentRow["shift"],
    status: e.status as EnrollmentRow["status"],
    byKind: e.by_kind as EnrollmentRow["byKind"],
    byName: e.by_name,
    exceptionReason: e.exception_reason,
    enrolledAt: e.enrolled_at,
    guardianName: e.guardian_name,
    accountId: e.account_id,
  };
}

/**
 * As vagas de uma classe, em duas consultas. Com `lock`, a linha da classe fica bloqueada até ao
 * fim da transação (FOR UPDATE): é isto que impede duas matrículas de ficarem com a última vaga.
 * As reservas fora do prazo não contam.
 */
async function classSeats(db: Db, classId: string, now: Date, lock: boolean, mineId: string | null = null) {
  const groups = lock
    ? await db.$queryRaw<{ vacancies: number | null; academic_year_id: string; year_status: string; id: string | null; name: string | null; shift: string | null; capacity: number | null }[]>`
        SELECT c.vacancies, c.academic_year_id, y.status AS year_status, g.id, g.name, g.shift, g.capacity
          FROM school_classes c JOIN academic_years y ON y.id = c.academic_year_id
          LEFT JOIN class_groups g ON g.class_id = c.id
         WHERE c.id = ${classId}::uuid
         FOR UPDATE OF c`
    : await db.$queryRaw<{ vacancies: number | null; academic_year_id: string; year_status: string; id: string | null; name: string | null; shift: string | null; capacity: number | null }[]>`
        SELECT c.vacancies, c.academic_year_id, y.status AS year_status, g.id, g.name, g.shift, g.capacity
          FROM school_classes c JOIN academic_years y ON y.id = c.academic_year_id
          LEFT JOIN class_groups g ON g.class_id = c.id
         WHERE c.id = ${classId}::uuid`;
  if (!groups.length) return null;
  const counts = await db.$queryRaw<{ group_id: string | null; status: string; n: number; mine: boolean }[]>`
    SELECT group_id, status, count(*)::int AS n, bool_or(id = ${mineId}::uuid) AS mine
      FROM seat_reservations
     WHERE class_id = ${classId}::uuid AND (status = 'CONFIRMED' OR (status = 'HELD' AND expires_at > ${now}))
     GROUP BY group_id, status`;
  const held = counts.filter((r) => r.status === "HELD").reduce((n, r) => n + r.n, 0);
  const confirmed = counts.filter((r) => r.status === "CONFIRMED").reduce((n, r) => n + r.n, 0);
  const list: GroupSeats[] = groups
    .filter((g) => g.id)
    .map((g) => ({ id: g.id!, name: g.name!, shift: g.shift as GroupSeats["shift"], capacity: g.capacity, confirmed: counts.filter((r) => r.status === "CONFIRMED" && r.group_id === g.id).reduce((n, r) => n + r.n, 0) }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt", { numeric: true }));
  const vacancies = effectiveVacancies(
    list.reduce((n, g) => n + (g.capacity ?? 0), 0),
    groups[0].vacancies,
  );
  return {
    academicYearId: groups[0].academic_year_id,
    closed: groups[0].year_status === "CLOSED",
    groups: list,
    vacancies,
    held,
    confirmed,
    available: Math.max(0, vacancies - held - confirmed),
    /** a reserva `mineId` ainda está guardada (HELD e no prazo) */
    mineHeld: counts.some((r) => r.status === "HELD" && r.mine),
  };
}

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

  async holdForApplication(input: { applicationId: string; classId: string; reference: string; expiresAt: Date; now: Date }): Promise<HoldOutcome> {
    return this.db.$transaction(async (tx) => {
      const app = await tx.application.findUnique({ where: { id: input.applicationId }, select: { seatReservationId: true } });
      const s = await classSeats(tx, input.classId, input.now, true, app?.seatReservationId ?? null);
      if (!s) return { ok: false, reason: "not_found" } as const;
      if (s.closed) return { ok: false, reason: "year_closed" } as const;
      if (s.mineHeld && app?.seatReservationId) return { ok: true, id: app.seatReservationId, expiresAt: input.expiresAt } as const;
      if (s.available <= 0) return { ok: false, reason: "no_vacancy" } as const;
      // uma reserva antiga desta inscrição, fora do prazo, deixa de contar (e liberta a referência)
      if (app?.seatReservationId) await tx.seatReservation.updateMany({ where: { id: app.seatReservationId, status: "HELD" }, data: { status: "RELEASED", updatedAt: input.now } });
      const id = randomUUID();
      await tx.seatReservation.create({ data: { id, academicYearId: s.academicYearId, classId: input.classId, status: "HELD", reference: input.reference, expiresAt: input.expiresAt, createdAt: input.now, updatedAt: input.now } });
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
    const app = await this.db.application.findUnique({ where: { id: applicationId }, select: { classId: true, seatReservationId: true, seatReservation: { select: { status: true, expiresAt: true } } } });
    if (!app?.classId) return null;
    const s = await classSeats(this.db, app.classId, now, false);
    if (!s) return null;
    const r = app.seatReservation;
    return {
      classId: app.classId,
      vacancies: s.vacancies,
      held: s.held,
      confirmed: s.confirmed,
      available: s.available,
      groups: s.groups,
      heldForApplication: r && r.status === "HELD" && app.seatReservationId ? { id: app.seatReservationId, expiresAt: r.expiresAt, expired: !!r.expiresAt && r.expiresAt <= now } : null,
    };
  }

  async fees(classId: string): Promise<ClassFeeRow[]> {
    const rows = await this.db.$queryRaw<{ name: string; billing: string; applies_to: string; charged_at: string; amount: number }[]>`
      SELECT f.name, f.billing, f.applies_to, f.charged_at, cf.amount
        FROM class_fees cf JOIN fee_items f ON f.id = cf.fee_item_id
       WHERE cf.class_id = ${classId}::uuid AND f.archived_at IS NULL
       ORDER BY f.position, f.name`;
    return rows.map((f) => ({
      name: f.name,
      billing: f.billing as ClassFeeRow["billing"],
      appliesTo: f.applies_to as ClassFeeRow["appliesTo"],
      chargedAt: f.charged_at as ClassFeeRow["chargedAt"],
      amount: f.amount,
    }));
  }

  /**
   * Matricular numa só transação, com poucas idas à BD (cada uma conta, com a BD no Neon):
   *   inscrição bloqueada → classe bloqueada e vagas → vaga confirmada numa turma → n.º do ano
   *   (contador bloqueado) → n.º de aluno → matrícula.
   * A unicidade (uma matrícula ativa por aluno e ano, uma por inscrição) fica garantida pelos índices.
   */
  async enroll(input: Parameters<EnrollmentsRepository["enroll"]>[0]): Promise<EnrollOutcome> {
    try {
      const id = await this.db.$transaction(async (tx) => {
        const [app] = await tx.$queryRaw<
          { id: string; status: string; student_id: string | null; class_id: string | null; academic_year_id: string | null; number: string | null; seat_reservation_id: string | null; enrolled: boolean; starts_on: Date | null; account_id: string; student_name: string | null; year_name: string | null }[]
        >`
          SELECT a.id, a.status, a.student_id, a.class_id, a.academic_year_id, a.number, a.seat_reservation_id, a.account_id,
                 (SELECT s.full_name FROM students s WHERE s.id = a.student_id) AS student_name,
                 (SELECT y.name FROM academic_years y WHERE y.id = a.academic_year_id) AS year_name,
                 EXISTS (SELECT 1 FROM enrollments e WHERE e.application_id = a.id
                          OR (e.student_id = a.student_id AND e.academic_year_id = a.academic_year_id AND e.status = 'ACTIVE')) AS enrolled,
                 (SELECT y.starts_on FROM academic_years y WHERE y.id = a.academic_year_id) AS starts_on
            FROM applications a WHERE a.id = ${input.applicationId}::uuid FOR UPDATE OF a`;
        if (!app || app.status !== "APPROVED" || !app.student_id || !app.class_id || !app.academic_year_id || !app.number || !app.starts_on) throw new Abort("not_approved");
        if (app.enrolled) throw new Abort("already_enrolled");

        const s = await classSeats(tx, app.class_id, input.now, true, app.seat_reservation_id);
        if (!s) throw new Abort("not_approved");
        if (s.closed) throw new Abort("year_closed");
        if (!s.groups.length) throw new Abort("no_groups");
        // sem vaga guardada (no prazo), precisa de uma livre (salvo exceção autorizada)
        if (!s.mineHeld && s.available <= 0 && !input.exceptionReason) throw new Abort("no_vacancy");

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
        if (s.mineHeld && app.seat_reservation_id) {
          seatId = app.seat_reservation_id;
          await tx.seatReservation.update({ where: { id: seatId }, data: { status: "CONFIRMED", groupId, expiresAt: null, updatedAt: input.now } });
        } else {
          // a reserva antiga (fora do prazo) deixa de contar e liberta a referência
          if (app.seat_reservation_id) await tx.seatReservation.updateMany({ where: { id: app.seat_reservation_id, status: "HELD" }, data: { status: "RELEASED", updatedAt: input.now } });
          seatId = randomUUID();
          await tx.seatReservation.create({ data: { id: seatId, academicYearId: app.academic_year_id, classId: app.class_id, groupId, status: "CONFIRMED", reference: app.number, createdAt: input.now, updatedAt: input.now } });
        }

        // n.º de matrícula do ano: o contador cria-se ou sobe numa só instrução (a linha fica bloqueada)
        const [{ last }] = await tx.$queryRaw<{ last: number }[]>`
          INSERT INTO enrollment_counters (academic_year_id, last) VALUES (${app.academic_year_id}::uuid, 1)
          ON CONFLICT (academic_year_id) DO UPDATE SET last = enrollment_counters.last + 1
          RETURNING last`;
        const number = formatEnrollmentNumber(input.cfg, iso(app.starts_on), Number(last));
        // n.º de aluno (permanente: só na primeira matrícula) e o estado
        await tx.$executeRaw`
          UPDATE students SET number = COALESCE(number, nextval('student_number_seq')::int), status = 'ENROLLED', updated_at = ${input.now}
           WHERE id = ${app.student_id}::uuid`;

        const eid = randomUUID();
        await tx.enrollment.create({
          data: {
            id: eid,
            number,
            studentId: app.student_id,
            applicationId: app.id,
            academicYearId: app.academic_year_id,
            classId: app.class_id,
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
        // o aviso na área da família (com o comprovativo)
        await notifyFamily(tx, {
          accountId: app.account_id,
          kind: "ENROLLED",
          title: `Matrícula confirmada: ${app.student_name ?? "aluno"}`,
          body: `N.º ${number} · ${app.year_name ?? ""} · turma ${group.name}`,
          link: `/familia/inscricoes/${app.id}/matricula`,
          studentId: app.student_id,
          now: input.now,
        });
        return eid;
      });
      return { ok: true, enrollment: (await this.byId(id))! };
    } catch (e) {
      if (e instanceof Abort) return { ok: false, reason: e.reason };
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "already_enrolled" };
      throw e;
    }
  }

  byApplication(applicationId: string) {
    return loadEnrollment(this.db, Prisma.sql`e.application_id = ${applicationId}::uuid`);
  }

  byId(id: string) {
    return loadEnrollment(this.db, Prisma.sql`e.id = ${id}::uuid`);
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
