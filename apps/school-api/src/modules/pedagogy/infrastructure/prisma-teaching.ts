import { randomUUID } from "node:crypto";
import type { PrismaClient } from ".prisma/tenant-client";
import type { Shift, YearStatus } from "../domain/academic";
import type { Qualification, QualificationData, QualificationLevel } from "../domain/qualifications";
import { TEACHER_STATUSES } from "../domain/teaching";
import { hhmm } from "../domain/timetable";
import type {
  GroupTeaching,
  QualificationCatalog,
  TeacherCandidate,
  TeacherGroup,
  TeacherLesson,
  TeacherLoad,
  TeachingOutcome,
  TeachingRepository,
  YearPlanGroup,
} from "../application/teaching-ports";

const CANDIDATE = { id: true, fullName: true, number: true, jobTitle: true, status: true, userId: true, employeeType: { select: { name: true } } } as const;
type CandidateRow = { id: string; fullName: string; number: number | null; jobTitle: string | null; status: string; userId: string | null; employeeType: { name: string } | null };
const toCandidate = (e: CandidateRow): TeacherCandidate => ({ id: e.id, fullName: e.fullName, number: e.number, jobTitle: e.jobTitle, status: e.status, typeName: e.employeeType?.name ?? null, hasPortal: !!e.userId });
const label = (grade: number, courseCode: string | null, group: string) => `${grade === 0 ? "Iniciação" : `${grade}.ª`}${courseCode ? ` ${courseCode}` : ""} · ${group}`;

/** Professores na BD do PRÓPRIO colégio. */
export class PrismaTeachingRepository implements TeachingRepository {
  constructor(private readonly db: PrismaClient) {}

  async currentYearId() {
    const y =
      (await this.db.academicYear.findFirst({ where: { status: "ACTIVE" }, orderBy: { startsOn: "desc" }, select: { id: true } })) ??
      (await this.db.academicYear.findFirst({ orderBy: { startsOn: "desc" }, select: { id: true } }));
    return y?.id ?? null;
  }

  async yearInfo(yearId: string) {
    const y = await this.db.academicYear.findUnique({ where: { id: yearId }, select: { id: true, name: true, status: true } });
    return y ? { ...y, status: y.status as YearStatus } : null;
  }

  async groupTeaching(groupId: string): Promise<GroupTeaching | null> {
    const g = await this.db.classGroup.findUnique({
      where: { id: groupId },
      include: {
        coordinator: { select: { id: true, fullName: true } },
        academicYear: { select: { id: true, name: true, status: true } },
        teachers: { include: { employee: { select: { id: true, fullName: true } } } },
        schoolClass: {
          include: {
            course: { select: { name: true, code: true } },
            subjects: { include: { subject: { select: { id: true, name: true, code: true, color: true } } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
          },
        },
      },
    });
    if (!g) return null;
    const scheduled = await this.db.lesson.groupBy({ by: ["subjectId"], where: { groupId }, _count: { _all: true } });
    const teacherOf = new Map(g.teachers.map((t) => [t.subjectId, t.employee]));
    return {
      group: { id: g.id, name: g.name, shift: g.shift as Shift, room: g.room, coordinator: g.coordinator },
      cls: { id: g.schoolClass.id, grade: g.schoolClass.grade, courseId: g.schoolClass.courseId, course: g.schoolClass.course?.name ?? null, courseCode: g.schoolClass.course?.code ?? null },
      year: { id: g.academicYear.id, name: g.academicYear.name, status: g.academicYear.status as YearStatus },
      subjects: g.schoolClass.subjects.map((s) => ({
        subject: s.subject,
        weeklyPeriods: s.weeklyPeriods,
        scheduled: scheduled.find((x) => x.subjectId === s.subjectId)?._count._all ?? 0,
        teacher: teacherOf.get(s.subjectId) ?? null,
      })),
    };
  }

  async candidates() {
    const rows = await this.db.employee.findMany({ where: { status: { in: [...TEACHER_STATUSES] } }, select: CANDIDATE, orderBy: { fullName: "asc" } });
    return rows.map(toCandidate);
  }

  async findTeacher(employeeId: string) {
    const e = await this.db.employee.findUnique({ where: { id: employeeId }, select: CANDIDATE });
    return e ? toCandidate(e) : null;
  }

  async employeeOfUser(userId: string) {
    const e = await this.db.employee.findUnique({ where: { userId }, select: CANDIDATE });
    return e ? toCandidate(e) : null;
  }

  private async openGroup(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], groupId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM class_groups WHERE id = ${groupId}::uuid FOR UPDATE`;
    if (!locked.length) return { ok: false, reason: "not_found" } as const;
    const g = (await tx.classGroup.findUnique({ where: { id: groupId }, include: { academicYear: { select: { status: true } } } }))!;
    if (g.academicYear.status === "CLOSED") return { ok: false, reason: "closed" } as const;
    return { ok: true, value: g } as const;
  }

  private async eligible(tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], employeeId: string) {
    return !!(await tx.employee.findFirst({ where: { id: employeeId, status: { in: [...TEACHER_STATUSES] } }, select: { id: true } }));
  }

  assign(input: { groupId: string; subjectId: string; employeeId: string | null; actorId: string | null; now: Date; onlyIfEmpty?: boolean }): Promise<TeachingOutcome> {
    return this.db.$transaction(async (tx) => {
      const g = await this.openGroup(tx, input.groupId);
      if (!g.ok) return g;
      const plan = await tx.classSubject.findUnique({ where: { classId_subjectId: { classId: g.value.classId, subjectId: input.subjectId } } });
      if (!plan) return { ok: false, reason: "not_in_curriculum" } as const;
      const key = { groupId_subjectId: { groupId: input.groupId, subjectId: input.subjectId } };
      if (input.onlyIfEmpty && (await tx.groupTeacher.findUnique({ where: key, select: { employeeId: true } }))) return { ok: false, reason: "taken" } as const;
      if (!input.employeeId) {
        await tx.groupTeacher.deleteMany({ where: { groupId: input.groupId, subjectId: input.subjectId } });
      } else {
        if (!(await this.eligible(tx, input.employeeId))) return { ok: false, reason: "teacher_invalid" } as const;
        await tx.groupTeacher.upsert({
          where: key,
          create: { groupId: input.groupId, subjectId: input.subjectId, employeeId: input.employeeId, assignedById: input.actorId, assignedAt: input.now },
          update: { employeeId: input.employeeId, assignedById: input.actorId, assignedAt: input.now },
        });
      }
      // as aulas já marcadas desta disciplina nesta turma passam a ser do novo professor
      await tx.lesson.updateMany({ where: { groupId: input.groupId, subjectId: input.subjectId }, data: { teacherId: input.employeeId, updatedAt: input.now } });
      return { ok: true, value: undefined } as const;
    });
  }

  setCoordinator(groupId: string, employeeId: string | null, now: Date, onlyIfEmpty?: boolean): Promise<TeachingOutcome> {
    return this.db.$transaction(async (tx) => {
      const g = await this.openGroup(tx, groupId);
      if (!g.ok) return g;
      if (onlyIfEmpty && g.value.coordinatorId) return { ok: false, reason: "taken" } as const;
      if (employeeId && !(await this.eligible(tx, employeeId))) return { ok: false, reason: "teacher_invalid" } as const;
      await tx.classGroup.update({ where: { id: groupId }, data: { coordinatorId: employeeId, updatedAt: now } });
      return { ok: true, value: undefined } as const;
    });
  }

  async teacherLessons(employeeId: string, yearId: string): Promise<TeacherLesson[]> {
    const rows = await this.db.lesson.findMany({
      where: { teacherId: employeeId, academicYearId: yearId },
      include: {
        period: true,
        subject: { select: { id: true, name: true, code: true, color: true } },
        group: { include: { schoolClass: { include: { course: { select: { code: true } } } } } },
      },
    });
    return rows
      .map((l) => ({
        id: l.id,
        weekday: l.weekday,
        startsAt: hhmm(l.period.startsAt),
        endsAt: hhmm(l.period.endsAt),
        position: l.period.position,
        shift: l.period.shift as Shift,
        groupId: l.groupId,
        groupName: l.group.name,
        grade: l.group.schoolClass.grade,
        courseCode: l.group.schoolClass.course?.code ?? null,
        subject: l.subject,
        room: l.room ?? l.group.room,
      }))
      .sort((a, b) => a.weekday - b.weekday || a.startsAt.localeCompare(b.startsAt));
  }

  async loads(yearId: string): Promise<TeacherLoad[]> {
    const [teachers, assignments, lessons, coordinated] = await Promise.all([
      this.candidates(),
      this.db.groupTeacher.findMany({ where: { group: { academicYearId: yearId } }, include: { group: { select: { classId: true } } } }),
      this.db.lesson.groupBy({ by: ["teacherId"], where: { academicYearId: yearId, teacherId: { not: null } }, _count: { _all: true } }),
      this.db.classGroup.findMany({ where: { academicYearId: yearId, coordinatorId: { not: null } }, include: { schoolClass: { include: { course: { select: { code: true } } } } } }),
    ]);
    const plans = await this.db.classSubject.findMany({ where: { academicYearId: yearId }, select: { classId: true, subjectId: true, weeklyPeriods: true } });
    const weekly = new Map(plans.map((p) => [`${p.classId}:${p.subjectId}`, p.weeklyPeriods]));
    // também quem já não está aprovado/ativo mas ainda tem turmas atribuídas
    const extraIds = [...new Set(assignments.map((a) => a.employeeId))].filter((id) => !teachers.some((t) => t.id === id));
    const extra = extraIds.length ? (await this.db.employee.findMany({ where: { id: { in: extraIds } }, select: CANDIDATE })).map(toCandidate) : [];
    return [...teachers, ...extra].map((t) => {
      const mine = assignments.filter((a) => a.employeeId === t.id);
      return {
        ...t,
        assignments: mine.length,
        weeklyPeriods: mine.reduce((n, a) => n + (weekly.get(`${a.group.classId}:${a.subjectId}`) ?? 0), 0),
        scheduled: lessons.find((l) => l.teacherId === t.id)?._count._all ?? 0,
        coordinates: coordinated.filter((g) => g.coordinatorId === t.id).map((g) => ({ id: g.id, label: label(g.schoolClass.grade, g.schoolClass.course?.code ?? null, g.name) })),
      };
    });
  }

  // ------------------------------------------------------------ habilitações

  async qualifications(employeeId: string): Promise<Qualification[]> {
    const rows = await this.db.teacherQualification.findMany({ where: { employeeId }, orderBy: { createdAt: "asc" } });
    return rows.map(toQualification);
  }

  async allQualifications() {
    const rows = await this.db.teacherQualification.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({ ...toQualification(r), employeeId: r.employeeId }));
  }

  async qualificationCatalog(): Promise<QualificationCatalog> {
    const [courses, subjects] = await Promise.all([
      this.db.course.findMany({ select: { id: true, name: true, code: true, archivedAt: true }, orderBy: { name: "asc" } }),
      this.db.subject.findMany({ select: { id: true, name: true, code: true, color: true, archivedAt: true }, orderBy: { name: "asc" } }),
    ]);
    return {
      courses: courses.map(({ archivedAt, ...c }) => ({ ...c, archived: !!archivedAt })),
      subjects: subjects.map(({ archivedAt, ...s }) => ({ ...s, archived: !!archivedAt })),
    };
  }

  async saveQualification(input: { id?: string; employeeId: string; data: QualificationData; now: Date }) {
    const data = { level: input.data.level, grades: input.data.grades, courseIds: input.data.courseIds, subjectIds: input.data.subjectIds, updatedAt: input.now };
    if (!input.id) {
      const id = randomUUID();
      await this.db.teacherQualification.create({ data: { id, employeeId: input.employeeId, createdAt: input.now, ...data } });
      return id;
    }
    const r = await this.db.teacherQualification.updateMany({ where: { id: input.id, employeeId: input.employeeId }, data });
    return r.count ? input.id : null;
  }

  async deleteQualification(employeeId: string, id: string) {
    return (await this.db.teacherQualification.deleteMany({ where: { id, employeeId } })).count > 0;
  }

  // ------------------------------------------------------------ propostas automáticas

  async yearPlan(yearId: string): Promise<YearPlanGroup[]> {
    const groups = await this.db.classGroup.findMany({
      where: { academicYearId: yearId },
      include: {
        teachers: { select: { subjectId: true, employeeId: true } },
        lessons: { select: { subjectId: true, teacherId: true, weekday: true, period: { select: { startsAt: true, endsAt: true } } } },
        schoolClass: { include: { course: { select: { code: true } }, subjects: { select: { subjectId: true, weeklyPeriods: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] } } },
      },
    });
    return groups
      .map((g) => {
        const teacherOf = new Map(g.teachers.map((t) => [t.subjectId, t.employeeId]));
        return {
          id: g.id,
          label: label(g.schoolClass.grade, g.schoolClass.course?.code ?? null, g.name),
          grade: g.schoolClass.grade,
          courseId: g.schoolClass.courseId,
          coordinatorId: g.coordinatorId,
          subjects: g.schoolClass.subjects.map((s) => ({ subjectId: s.subjectId, weeklyPeriods: s.weeklyPeriods, teacherId: teacherOf.get(s.subjectId) ?? null })),
          lessons: g.lessons.map((l) => ({ subjectId: l.subjectId, teacherId: l.teacherId, weekday: l.weekday, startsAt: hhmm(l.period.startsAt), endsAt: hhmm(l.period.endsAt) })),
        };
      })
      .sort((a, b) => a.grade - b.grade || a.label.localeCompare(b.label));
  }

  // ------------------------------------------------------------ as turmas do professor

  async teacherGroups(employeeId: string, yearId: string): Promise<TeacherGroup[]> {
    const groups = await this.db.classGroup.findMany({
      where: { academicYearId: yearId, OR: [{ teachers: { some: { employeeId } } }, { coordinatorId: employeeId }] },
      include: {
        coordinator: { select: { id: true, fullName: true } },
        teachers: { where: { employeeId }, select: { subjectId: true } },
        lessons: { where: { teacherId: employeeId }, select: { subjectId: true } },
        schoolClass: {
          include: {
            course: { select: { name: true, code: true } },
            subjects: { include: { subject: { select: { id: true, name: true, code: true, color: true } } }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
          },
        },
      },
    });
    return groups
      .map((g) => {
        const mine = new Set(g.teachers.map((t) => t.subjectId));
        return {
          id: g.id,
          name: g.name,
          label: label(g.schoolClass.grade, g.schoolClass.course?.code ?? null, g.name),
          grade: g.schoolClass.grade,
          course: g.schoolClass.course?.name ?? null,
          courseCode: g.schoolClass.course?.code ?? null,
          shift: g.shift as Shift,
          room: g.room,
          coordinator: g.coordinator,
          isCoordinator: g.coordinatorId === employeeId,
          planSubjects: g.schoolClass.subjects.length,
          subjects: g.schoolClass.subjects
            .filter((s) => mine.has(s.subjectId))
            .map((s) => ({ subject: s.subject, weeklyPeriods: s.weeklyPeriods, scheduled: g.lessons.filter((l) => l.subjectId === s.subjectId).length })),
        };
      })
      .sort((a, b) => a.grade - b.grade || a.label.localeCompare(b.label));
  }

  async groupAccess(employeeId: string, groupId: string) {
    const [teaches, group] = await Promise.all([
      this.db.groupTeacher.findMany({ where: { groupId, employeeId }, select: { subjectId: true } }),
      this.db.classGroup.findUnique({ where: { id: groupId }, select: { coordinatorId: true } }),
    ]);
    if (!group) return null;
    const coordinates = group.coordinatorId === employeeId;
    return teaches.length || coordinates ? { subjectIds: teaches.map((t) => t.subjectId), coordinates } : null;
  }
}

const toQualification = (r: { id: string; level: string; grades: number[]; courseIds: string[]; subjectIds: string[] }): Qualification => ({
  id: r.id,
  level: r.level as QualificationLevel,
  grades: r.grades,
  courseIds: r.courseIds,
  subjectIds: r.subjectIds,
});

export const groupLabel = label;
