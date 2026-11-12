import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { Shift, YearStatus } from "../domain/academic";
import { DEFAULT_PERIODS, hhmm, type PeriodInput, type PeriodKind, type SubjectInput, timeOf } from "../domain/timetable";
import type { ClassCurriculum, GroupTimetable, LessonRow, PeriodRow, SubjectOutcome, SubjectRow, TimetableOutcome, TimetableRepository } from "../application/timetable-ports";

type Tx = Prisma.TransactionClient;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
/** Bloqueio consultivo das escritas nos tempos letivos (um por turno). */
const PERIODS_LOCK = { MANHA: 7_200_501, TARDE: 7_200_502, NOITE: 7_200_503 } as const;

const WITH_COUNTS = { _count: { select: { classes: true, lessons: true } } } as const;
const toSubject = (s: { id: string; name: string; code: string; color: string; archivedAt: Date | null; _count?: { classes: number; lessons: number } }): SubjectRow => ({
  id: s.id,
  name: s.name,
  code: s.code,
  color: s.color,
  archivedAt: s.archivedAt,
  classCount: s._count?.classes ?? 0,
  lessonCount: s._count?.lessons ?? 0,
});
const toPeriod = (p: { id: string; shift: string; position: number; startsAt: Date; endsAt: Date; kind: string }): PeriodRow => ({
  id: p.id,
  shift: p.shift as Shift,
  position: p.position,
  startsAt: hhmm(p.startsAt),
  endsAt: hhmm(p.endsAt),
  kind: p.kind as PeriodKind,
});
const toLesson = (l: { id: string; weekday: number; periodId: string; subjectId: string; teacherId: string | null; room: string | null }): LessonRow => ({
  id: l.id,
  weekday: l.weekday,
  periodId: l.periodId,
  subjectId: l.subjectId,
  teacherId: l.teacherId,
  room: l.room,
});

export class PrismaTimetableRepository implements TimetableRepository {
  constructor(private readonly db: PrismaClient) {}

  // ================================================================ disciplinas

  async listSubjects() {
    return (await this.db.subject.findMany({ include: WITH_COUNTS, orderBy: { name: "asc" } })).map(toSubject);
  }

  async findSubject(id: string) {
    const s = await this.db.subject.findUnique({ where: { id }, include: WITH_COUNTS });
    return s ? toSubject(s) : null;
  }

  private async clash(tx: Tx, input: SubjectInput, exceptId?: string) {
    const not = exceptId ? { id: { not: exceptId } } : {};
    if (await tx.subject.findFirst({ where: { name: { equals: input.name, mode: "insensitive" }, ...not }, select: { id: true } })) return "name_taken" as const;
    if (await tx.subject.findFirst({ where: { code: input.code, ...not }, select: { id: true } })) return "code_taken" as const;
    return null;
  }

  async createSubject(input: SubjectInput & { id: string; now: Date }): Promise<SubjectOutcome<SubjectRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        const clash = await this.clash(tx, input);
        if (clash) return { ok: false, reason: clash } as const;
        const s = await tx.subject.create({ data: { id: input.id, name: input.name, code: input.code, color: input.color, createdAt: input.now, updatedAt: input.now } });
        return { ok: true, value: toSubject(s) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
  }

  async updateSubject(id: string, input: SubjectInput & { now: Date }): Promise<SubjectOutcome<SubjectRow>> {
    try {
      return await this.db.$transaction(async (tx) => {
        if (!(await tx.subject.findUnique({ where: { id }, select: { id: true } }))) return { ok: false, reason: "not_found" } as const;
        const clash = await this.clash(tx, input, id);
        if (clash) return { ok: false, reason: clash } as const;
        const s = await tx.subject.update({ where: { id }, data: { name: input.name, code: input.code, color: input.color, updatedAt: input.now }, include: WITH_COUNTS });
        return { ok: true, value: toSubject(s) } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
  }

  async setSubjectArchived(id: string, archived: boolean, now: Date): Promise<SubjectOutcome<SubjectRow>> {
    const changed = await this.db.subject.updateMany({ where: { id }, data: { archivedAt: archived ? now : null, updatedAt: now } });
    if (!changed.count) return { ok: false, reason: "not_found" };
    return { ok: true, value: (await this.findSubject(id))! };
  }

  async deleteSubject(id: string): Promise<SubjectOutcome<void>> {
    try {
      const deleted = await this.db.subject.deleteMany({ where: { id, classes: { none: {} }, lessons: { none: {} } } });
      if (deleted.count) return { ok: true, value: undefined };
      return (await this.db.subject.findUnique({ where: { id }, select: { id: true } })) ? { ok: false, reason: "in_use" } : { ok: false, reason: "not_found" };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") return { ok: false, reason: "in_use" };
      throw e;
    }
  }

  // ================================================================ plano curricular

  async yearCurricula(yearId: string) {
    const rows = await this.db.classSubject.groupBy({ by: ["classId"], where: { academicYearId: yearId }, _count: { _all: true }, _sum: { weeklyPeriods: true } });
    return rows.map((r) => ({ classId: r.classId, subjects: r._count._all, weeklyPeriods: r._sum.weeklyPeriods ?? 0 }));
  }

  async classCurriculum(classId: string): Promise<ClassCurriculum | null> {
    const c = await this.db.schoolClass.findUnique({
      where: { id: classId },
      include: {
        groups: { orderBy: { name: "asc" } },
        course: { select: { name: true, code: true } },
        academicYear: { select: { status: true } },
        subjects: { include: { subject: { include: WITH_COUNTS } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (!c) return null;
    const lessons = await this.db.lesson.groupBy({ by: ["subjectId", "groupId"], where: { group: { classId } }, _count: { _all: true } });
    const scheduled: ClassCurriculum["scheduled"] = {};
    for (const l of lessons) (scheduled[l.subjectId] ??= {})[l.groupId] = l._count._all;
    return {
      cls: {
        id: c.id,
        academicYearId: c.academicYearId,
        grade: c.grade,
        course: c.course?.name ?? null,
        courseCode: c.course?.code ?? null,
        yearStatus: c.academicYear.status as YearStatus,
        groups: c.groups.map((g) => ({ id: g.id, name: g.name, shift: g.shift as Shift })),
      },
      items: c.subjects.map((s) => ({ subject: toSubject(s.subject), weeklyPeriods: s.weeklyPeriods })),
      scheduled,
    };
  }

  async setCurriculum(classId: string, items: { subjectId: string; weeklyPeriods: number }[], now: Date): Promise<TimetableOutcome<void>> {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_classes WHERE id = ${classId}::uuid FOR UPDATE`;
      if (!locked.length) return { ok: false, reason: "not_found" } as const;
      const c = (await tx.schoolClass.findUnique({ where: { id: classId }, include: { academicYear: { select: { status: true } } } }))!;
      if (c.academicYear.status === "CLOSED") return { ok: false, reason: "closed" } as const;
      // o horário manda: não se retira nem se baixa abaixo do que já está marcado (na turma com mais tempos)
      const marked = await tx.lesson.groupBy({ by: ["subjectId", "groupId"], where: { group: { classId } }, _count: { _all: true } });
      for (const m of marked) {
        const keep = items.find((i) => i.subjectId === m.subjectId);
        if (!keep || keep.weeklyPeriods < m._count._all) return { ok: false, reason: "in_lessons", subjectId: m.subjectId, count: m._count._all } as const;
      }
      await tx.classSubject.deleteMany({ where: { classId } });
      if (items.length) {
        await tx.classSubject.createMany({
          data: items.map((i, position) => ({ id: randomUUID(), academicYearId: c.academicYearId, classId, subjectId: i.subjectId, weeklyPeriods: i.weeklyPeriods, position, createdAt: now })),
        });
      }
      return { ok: true, value: undefined } as const;
    });
  }

  // ================================================================ tempos letivos

  async periods(shift: Shift, now: Date): Promise<PeriodRow[]> {
    const rows = await this.db.schoolPeriod.findMany({ where: { shift }, orderBy: { position: "asc" } });
    if (rows.length) return rows.map(toPeriod);
    // primeira vez: os tempos por omissão do turno (o índice único evita duplicados em pedidos simultâneos)
    await this.db.schoolPeriod.createMany({
      data: DEFAULT_PERIODS[shift].map((p, i) => ({ id: randomUUID(), shift, position: i + 1, startsAt: timeOf(p.startsAt), endsAt: timeOf(p.endsAt), kind: p.kind, createdAt: now, updatedAt: now })),
      skipDuplicates: true,
    });
    return (await this.db.schoolPeriod.findMany({ where: { shift }, orderBy: { position: "asc" } })).map(toPeriod);
  }

  async setPeriods(shift: Shift, items: PeriodInput[], now: Date): Promise<TimetableOutcome<PeriodRow[]>> {
    await this.periods(shift, now);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PERIODS_LOCK[shift]})`;
      const existing = await tx.schoolPeriod.findMany({ where: { shift }, include: { _count: { select: { lessons: true } } }, orderBy: { position: "asc" } });
      for (const p of existing) {
        const next = items[p.position - 1];
        // não se apaga nem se torna intervalo um tempo que já tem aulas marcadas
        if (p._count.lessons > 0 && (!next || next.kind === "INTERVALO")) return { ok: false, reason: "period_in_use", position: p.position, count: p._count.lessons } as const;
      }
      for (const p of existing) {
        const next = items[p.position - 1];
        if (next) await tx.schoolPeriod.update({ where: { id: p.id }, data: { startsAt: timeOf(next.startsAt), endsAt: timeOf(next.endsAt), kind: next.kind, updatedAt: now } });
        else await tx.schoolPeriod.delete({ where: { id: p.id } });
      }
      const added = items.slice(existing.length);
      if (added.length) {
        await tx.schoolPeriod.createMany({
          data: added.map((p, i) => ({ id: randomUUID(), shift, position: existing.length + i + 1, startsAt: timeOf(p.startsAt), endsAt: timeOf(p.endsAt), kind: p.kind, createdAt: now, updatedAt: now })),
        });
      }
      return { ok: true, value: (await tx.schoolPeriod.findMany({ where: { shift }, orderBy: { position: "asc" } })).map(toPeriod) } as const;
    });
  }

  // ================================================================ horário

  async groupTimetable(groupId: string, now: Date): Promise<GroupTimetable | null> {
    const g = await this.db.classGroup.findUnique({
      where: { id: groupId },
      include: {
        schoolClass: { include: { course: { select: { name: true, code: true } }, subjects: { include: { subject: { include: WITH_COUNTS } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] } } },
        academicYear: { select: { id: true, name: true, status: true } },
        lessons: true,
      },
    });
    if (!g) return null;
    const periods = await this.periods(g.shift as Shift, now);
    return {
      group: { id: g.id, name: g.name, shift: g.shift as Shift, room: g.room, capacity: g.capacity },
      cls: { id: g.schoolClass.id, grade: g.schoolClass.grade, course: g.schoolClass.course?.name ?? null, courseCode: g.schoolClass.course?.code ?? null },
      year: { id: g.academicYear.id, name: g.academicYear.name, status: g.academicYear.status as YearStatus },
      periods,
      lessons: g.lessons.map(toLesson),
      curriculum: g.schoolClass.subjects.map((s) => ({ subject: toSubject(s.subject), weeklyPeriods: s.weeklyPeriods })),
    };
  }

  async yearTimetables(yearId: string) {
    const rows = await this.db.lesson.groupBy({ by: ["groupId"], where: { academicYearId: yearId }, _count: { _all: true } });
    return rows.map((r) => ({ groupId: r.groupId, scheduled: r._count._all }));
  }

  /** Quem está na sala nesse tempo (para a mensagem): "10.ª CFB · turma A". */
  private async roomUser(db: Tx | PrismaClient, yearId: string, weekday: number, periodId: string, room: string, exceptGroup: string) {
    const other = await db.lesson.findFirst({
      where: { academicYearId: yearId, weekday, periodId, room: { equals: room, mode: "insensitive" }, groupId: { not: exceptGroup } },
      include: { group: { include: { schoolClass: { include: { course: { select: { code: true } } } } } } },
    });
    if (!other) return null;
    const c = other.group.schoolClass;
    return { room: other.room ?? room, by: `${c.grade === 0 ? "Iniciação" : `${c.grade}.ª`}${c.course?.code ? ` ${c.course.code}` : ""} · turma ${other.group.name}` };
  }

  async setLesson(input: { id: string; groupId: string; weekday: number; periodId: string; subjectId: string | null; room: string | null; now: Date }): Promise<TimetableOutcome<LessonRow | null>> {
    let attempt: { yearId: string; room: string } | null = null;
    try {
      return await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM class_groups WHERE id = ${input.groupId}::uuid FOR UPDATE`;
        if (!locked.length) return { ok: false, reason: "not_found" } as const;
        const g = (await tx.classGroup.findUnique({ where: { id: input.groupId }, include: { academicYear: { select: { status: true } } } }))!;
        if (g.academicYear.status === "CLOSED") return { ok: false, reason: "closed" } as const;
        const period = await tx.schoolPeriod.findUnique({ where: { id: input.periodId } });
        if (!period || period.shift !== g.shift || period.kind !== "AULA" || input.weekday < 1 || input.weekday > 5) return { ok: false, reason: "slot_invalid" } as const;
        const slot = { groupId_weekday_periodId: { groupId: input.groupId, weekday: input.weekday, periodId: input.periodId } };

        if (!input.subjectId) {
          await tx.lesson.deleteMany({ where: { groupId: input.groupId, weekday: input.weekday, periodId: input.periodId } });
          return { ok: true, value: null } as const;
        }
        const plan = await tx.classSubject.findUnique({ where: { classId_subjectId: { classId: g.classId, subjectId: input.subjectId } } });
        if (!plan) return { ok: false, reason: "not_in_curriculum" } as const;
        // tempos semanais: os já marcados desta disciplina nesta turma, sem contar o tempo que se está a mudar
        const used = await tx.lesson.count({ where: { groupId: input.groupId, subjectId: input.subjectId, NOT: { weekday: input.weekday, periodId: input.periodId } } });
        if (used >= plan.weeklyPeriods) return { ok: false, reason: "weekly_limit", limit: plan.weeklyPeriods } as const;
        const room = input.room?.trim() || g.room || null;
        if (room) {
          attempt = { yearId: g.academicYearId, room };
          const busy = await this.roomUser(tx, g.academicYearId, input.weekday, input.periodId, room, input.groupId);
          if (busy) return { ok: false, reason: "room_busy", room: busy.room, by: busy.by } as const;
        }
        const l = await tx.lesson.upsert({
          where: slot,
          create: { id: input.id, academicYearId: g.academicYearId, groupId: input.groupId, weekday: input.weekday, periodId: input.periodId, subjectId: input.subjectId, room, createdAt: input.now, updatedAt: input.now },
          update: { subjectId: input.subjectId, room, updatedAt: input.now },
        });
        return { ok: true, value: toLesson(l) } as const;
      });
    } catch (e) {
      // outra turma ocupou a sala no mesmo instante (índice único da sala)
      if (isUnique(e) && attempt) {
        const a = attempt as { yearId: string; room: string };
        const busy = await this.roomUser(this.db, a.yearId, input.weekday, input.periodId, a.room, input.groupId);
        return { ok: false, reason: "room_busy", room: busy?.room ?? a.room, by: busy?.by ?? "outra turma" };
      }
      throw e;
    }
  }
}
