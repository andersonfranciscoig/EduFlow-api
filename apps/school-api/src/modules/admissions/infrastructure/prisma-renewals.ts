import type { PrismaClient } from ".prisma/tenant-client";
import type { NextClassRow, RenewalAppRow, RenewalCandidateRow, RenewalsRepository, StaffRenewalRow } from "../application/Renewals";
import type { ApplicationStatus, Entry, Shift } from "../domain/applications";
import type { RenewalWindow } from "../domain/renewals";

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const json = (v: unknown) => (v && typeof v === "object" ? (v as Entry) : {});
const ORDER: Shift[] = ["MANHA", "TARDE", "NOITE"];

/** Renovações na BD do PRÓPRIO colégio. */
export class PrismaRenewalsRepository implements RenewalsRepository {
  constructor(private readonly db: PrismaClient) {}

  async windows(): Promise<RenewalWindow[]> {
    const rows = await this.db.$queryRaw<{ id: string; name: string; starts_on: Date; renewals_from: Date | null; renewals_to: Date | null }[]>`
      SELECT y.id, y.name, y.starts_on, p.renewals_from, p.renewals_to
        FROM academic_years y LEFT JOIN admission_periods p ON p.academic_year_id = y.id
       WHERE y.status <> 'CLOSED' ORDER BY y.starts_on`;
    return rows.map((r) => ({ id: r.id, name: r.name, startsOn: iso(r.starts_on)!, from: iso(r.renewals_from), to: iso(r.renewals_to) }));
  }

  async candidates(accountId: string): Promise<RenewalCandidateRow[]> {
    const rows = await this.db.$queryRaw<
      {
        id: string;
        full_name: string;
        birth_date: Date;
        number: number | null;
        self: boolean;
        managing: boolean;
        year_id: string | null;
        year_name: string | null;
        starts_on: Date | null;
        grade: number | null;
        course_id: string | null;
        course_name: string | null;
        group_name: string | null;
        shift: string | null;
      }[]
    >`
      SELECT s.id, s.full_name, s.birth_date, s.number,
             (s.account_id IS NOT DISTINCT FROM ${accountId}::uuid) AS self,
             EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                      WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage) AS managing,
             e.year_id, e.year_name, e.starts_on, e.grade, e.course_id, e.course_name, e.group_name, e.shift
        FROM students s
        LEFT JOIN LATERAL (
          SELECT y.id AS year_id, y.name AS year_name, y.starts_on, c.grade, c.course_id, co.name AS course_name, g.name AS group_name, e.shift
            FROM enrollments e JOIN academic_years y ON y.id = e.academic_year_id JOIN school_classes c ON c.id = e.class_id
            LEFT JOIN courses co ON co.id = c.course_id LEFT JOIN class_groups g ON g.id = e.group_id
           WHERE e.student_id = s.id AND e.status = 'ACTIVE' ORDER BY y.starts_on DESC LIMIT 1) e ON TRUE
       WHERE s.account_id = ${accountId}::uuid
          OR EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage)
       ORDER BY s.full_name`;
    return rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      birthDate: iso(r.birth_date)!,
      number: r.number,
      self: !!r.self,
      managing: !!r.managing,
      current:
        r.year_id && r.starts_on && r.grade !== null
          ? { yearId: r.year_id, yearName: r.year_name!, yearStartsOn: iso(r.starts_on)!, grade: r.grade, courseId: r.course_id, courseName: r.course_name, groupName: r.group_name, shift: r.shift as Shift | null }
          : null,
    }));
  }

  async apps(studentIds: string[]): Promise<RenewalAppRow[]> {
    if (!studentIds.length) return [];
    const rows = await this.db.$queryRaw<{ id: string; student_id: string; academic_year_id: string; status: string; number: string | null; enrollment_number: string | null }[]>`
      SELECT a.id, a.student_id, a.academic_year_id, a.status, a.number,
             (SELECT e.number FROM enrollments e WHERE e.application_id = a.id AND e.status = 'ACTIVE' LIMIT 1) AS enrollment_number
        FROM applications a
       WHERE a.process_type = 'RENOVACAO' AND a.student_id = ANY(${studentIds}::uuid[]) AND a.academic_year_id IS NOT NULL
       ORDER BY a.created_at DESC`;
    return rows.map((r) => ({ id: r.id, studentId: r.student_id, academicYearId: r.academic_year_id, status: r.status as ApplicationStatus, number: r.number, enrollmentNumber: r.enrollment_number }));
  }

  async nextClasses(yearId: string, grade: number, courseId: string | null): Promise<NextClassRow[]> {
    const rows = await this.db.schoolClass.findMany({
      where: { academicYearId: yearId, grade: grade + 1, ...(courseId ? { courseId } : {}) },
      orderBy: { createdAt: "asc" },
      include: { course: { select: { name: true } }, groups: { select: { shift: true } } },
    });
    return rows.map((c) => ({ id: c.id, grade: c.grade, courseName: c.course?.name ?? null, shifts: ORDER.filter((s) => c.groups.some((g) => g.shift === s)) }));
  }

  async prefill(studentId: string, accountId: string) {
    const [s, guardians] = await Promise.all([
      this.db.student.findUnique({ where: { id: studentId }, select: { fullName: true, birthDate: true, gender: true, data: true } }),
      this.db.$queryRaw<{ full_name: string; email: string | null; phone: string | null; data: unknown; relationship: string; relationship_other: string | null; mine: boolean }[]>`
        SELECT g.full_name, g.email, g.phone, g.data, sg.relationship, sg.relationship_other, (g.account_id IS NOT DISTINCT FROM ${accountId}::uuid) AS mine
          FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
         WHERE sg.student_id = ${studentId}::uuid ORDER BY (g.account_id IS NOT DISTINCT FROM ${accountId}::uuid) DESC, sg.is_primary DESC LIMIT 1`,
    ]);
    const student: Entry = s ? { ...json(s.data), fullName: s.fullName, birthDate: iso(s.birthDate)!, ...(s.gender ? { gender: s.gender } : {}) } : {};
    const g = guardians[0];
    const guardian: Entry = g
      ? {
          ...json(g.data),
          fullName: g.full_name,
          ...(g.email ? { email: g.email } : {}),
          ...(g.phone ? { phone: g.phone } : {}),
          relationship: g.relationship,
          ...(g.relationship_other ? { relationshipOther: g.relationship_other } : {}),
        }
      : {};
    return { student, guardian };
  }

  async staffRows(targetYearId: string, previousYearId: string): Promise<StaffRenewalRow[]> {
    const rows = await this.db.$queryRaw<
      {
        student_id: string;
        full_name: string;
        number: number | null;
        grade: number;
        course_name: string | null;
        group_name: string | null;
        guardian_name: string | null;
        guardian_phone: string | null;
        app_id: string | null;
        app_number: string | null;
        status: string | null;
        enrollment_number: string | null;
      }[]
    >`
      SELECT s.id AS student_id, s.full_name, s.number, c.grade, co.name AS course_name, g.name AS group_name,
             gu.full_name AS guardian_name, gu.phone AS guardian_phone,
             a.id AS app_id, a.number AS app_number, a.status,
             (SELECT e2.number FROM enrollments e2 WHERE e2.student_id = s.id AND e2.academic_year_id = ${targetYearId}::uuid AND e2.status = 'ACTIVE' LIMIT 1) AS enrollment_number
        FROM enrollments e
        JOIN students s ON s.id = e.student_id
        JOIN school_classes c ON c.id = e.class_id
        LEFT JOIN courses co ON co.id = c.course_id
        LEFT JOIN class_groups g ON g.id = e.group_id
        LEFT JOIN LATERAL (SELECT gx.full_name, gx.phone FROM student_guardians sg JOIN guardians gx ON gx.id = sg.guardian_id
                            WHERE sg.student_id = s.id ORDER BY sg.is_primary DESC LIMIT 1) gu ON TRUE
        LEFT JOIN LATERAL (SELECT a.id, a.number, a.status FROM applications a
                            WHERE a.student_id = s.id AND a.academic_year_id = ${targetYearId}::uuid AND a.process_type = 'RENOVACAO'
                            ORDER BY (a.status IN ('REJECTED','CANCELLED')), a.created_at DESC LIMIT 1) a ON TRUE
       WHERE e.academic_year_id = ${previousYearId}::uuid AND e.status = 'ACTIVE'
       ORDER BY c.grade, co.name NULLS FIRST, g.name NULLS LAST, s.full_name`;
    return rows.map((r) => ({
      studentId: r.student_id,
      fullName: r.full_name,
      number: r.number,
      grade: r.grade,
      courseName: r.course_name,
      groupName: r.group_name,
      guardianName: r.guardian_name,
      guardianPhone: r.guardian_phone,
      applicationId: r.app_id,
      applicationNumber: r.app_number,
      status: r.status as ApplicationStatus | null,
      enrollmentNumber: r.enrollment_number,
    }));
  }
}
