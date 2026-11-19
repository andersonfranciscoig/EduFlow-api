import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { StudentDetailRow, StudentListRow, StudentsRepository } from "../application/Students";
import type { ApplicationStatus, Entry, Shift } from "../domain/applications";
import type { ProcessType } from "../domain/settings";
import type { StudentStatus } from "../domain/students";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => (v && typeof v === "object" ? (v as Entry) : {});

/** Alunos na BD do PRÓPRIO colégio (leituras em SQL: com a BD no Neon, cada ida conta). */
export class PrismaStudentsRepository implements StudentsRepository {
  constructor(private readonly db: PrismaClient) {}

  async list(f: Parameters<StudentsRepository["list"]>[0]) {
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.status) conds.push(Prisma.sql`s.status = ${f.status}`);
    // com ano/classe: a matrícula (ativa) desse ano/classe; sem filtro: a matrícula ativa mais recente
    const enr: Prisma.Sql[] = [Prisma.sql`e.student_id = s.id`, Prisma.sql`e.status = 'ACTIVE'`];
    if (f.yearId) enr.push(Prisma.sql`e.academic_year_id = ${f.yearId}::uuid`);
    if (f.classId) enr.push(Prisma.sql`e.class_id = ${f.classId}::uuid`);
    if (f.yearId || f.classId) conds.push(Prisma.sql`e.id IS NOT NULL`);
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const digits = f.q.replace(/^0+/, "");
      conds.push(Prisma.sql`(s.full_name ILIKE ${like} OR e.number ILIKE ${like} OR s.data->>'idNumber' ILIKE ${like}
        OR (${/^\d+$/.test(f.q)} AND s.number::text = ${digits})
        OR EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.student_id = s.id AND e2.number ILIKE ${like}))`);
    }
    const rows = await this.db.$queryRaw<
      {
        id: string;
        number: number | null;
        full_name: string;
        birth_date: Date;
        status: string;
        enrollment_number: string | null;
        year_name: string | null;
        grade: number | null;
        course_name: string | null;
        group_name: string | null;
        guardian_name: string | null;
        guardian_phone: string | null;
        phone: string | null;
        photo_id: string | null;
        has_account: boolean;
        total: bigint;
      }[]
    >`
      SELECT s.id, s.number, s.full_name, s.birth_date, s.status,
             e.number AS enrollment_number, y.name AS year_name, c.grade, co.name AS course_name, g.name AS group_name,
             gu.full_name AS guardian_name, gu.phone AS guardian_phone, s.data->>'phone' AS phone,
             (SELECT fi.id FROM application_files fi JOIN applications a ON a.id = fi.application_id
               WHERE a.student_id = s.id AND fi.slot = 'PHOTO' ORDER BY fi.created_at DESC LIMIT 1) AS photo_id,
             (s.account_id IS NOT NULL OR EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians gg ON gg.id = sg.guardian_id WHERE sg.student_id = s.id AND gg.account_id IS NOT NULL)) AS has_account,
             count(*) OVER () AS total
        FROM students s
        LEFT JOIN LATERAL (SELECT * FROM enrollments e WHERE ${Prisma.join(enr, " AND ")} ORDER BY e.enrolled_at DESC LIMIT 1) e ON TRUE
        LEFT JOIN academic_years y ON y.id = e.academic_year_id
        LEFT JOIN school_classes c ON c.id = e.class_id
        LEFT JOIN courses co ON co.id = c.course_id
        LEFT JOIN class_groups g ON g.id = e.group_id
        LEFT JOIN LATERAL (SELECT gx.full_name, gx.phone FROM student_guardians sg JOIN guardians gx ON gx.id = sg.guardian_id
                            WHERE sg.student_id = s.id ORDER BY sg.is_primary DESC LIMIT 1) gu ON TRUE
       WHERE ${Prisma.join(conds, " AND ")}
       ORDER BY s.full_name
       LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map(
        (r): StudentListRow => ({
          id: r.id,
          number: r.number,
          fullName: r.full_name,
          birthDate: r.birth_date,
          status: r.status as StudentStatus,
          enrollmentNumber: r.enrollment_number,
          yearName: r.year_name,
          grade: r.grade,
          courseName: r.course_name,
          groupName: r.group_name,
          guardianName: r.guardian_name,
          guardianPhone: r.guardian_phone,
          phone: r.phone,
          photoId: r.photo_id,
          hasAccount: r.has_account,
        }),
      ),
    };
  }

  async filterYears() {
    const rows = await this.db.$queryRaw<{ year_id: string; year_name: string; class_id: string; grade: number; course_name: string | null }[]>`
      SELECT y.id AS year_id, y.name AS year_name, c.id AS class_id, c.grade, co.name AS course_name
        FROM academic_years y JOIN school_classes c ON c.academic_year_id = y.id LEFT JOIN courses co ON co.id = c.course_id
       WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.academic_year_id = y.id)
       ORDER BY y.starts_on DESC, c.grade, co.name NULLS FIRST`;
    const years: { id: string; name: string; classes: { id: string; grade: number; courseName: string | null }[] }[] = [];
    for (const r of rows) {
      let y = years.find((x) => x.id === r.year_id);
      if (!y) years.push((y = { id: r.year_id, name: r.year_name, classes: [] }));
      y.classes.push({ id: r.class_id, grade: r.grade, courseName: r.course_name });
    }
    return years;
  }

  async detail(id: string): Promise<StudentDetailRow | null> {
    const [s, guardians, enrollments, applications, files] = await Promise.all([
      this.db.student.findUnique({ where: { id } }),
      this.db.$queryRaw<{ id: string; full_name: string; email: string | null; phone: string | null; data: unknown; account_id: string | null; relationship: string; relationship_other: string | null; is_primary: boolean; is_emergency: boolean; is_financial: boolean; can_manage: boolean }[]>`
        SELECT g.id, g.full_name, g.email, g.phone, g.data, g.account_id, sg.relationship, sg.relationship_other, sg.is_primary, sg.is_emergency, sg.is_financial, sg.can_manage
          FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ${id}::uuid
         ORDER BY sg.is_primary DESC, g.full_name`,
      this.db.$queryRaw<{ id: string; number: string; application_id: string | null; year_name: string; grade: number; course_name: string | null; group_name: string | null; shift: string | null; status: string; by_name: string | null; exception_reason: string | null; enrolled_at: Date }[]>`
        SELECT e.id, e.number, e.application_id, y.name AS year_name, c.grade, co.name AS course_name, g.name AS group_name, e.shift, e.status, e.by_name, e.exception_reason, e.enrolled_at
          FROM enrollments e JOIN academic_years y ON y.id = e.academic_year_id JOIN school_classes c ON c.id = e.class_id
          LEFT JOIN courses co ON co.id = c.course_id LEFT JOIN class_groups g ON g.id = e.group_id
         WHERE e.student_id = ${id}::uuid ORDER BY e.enrolled_at DESC`,
      this.db.$queryRaw<{ id: string; number: string | null; process_type: string; status: string; year_name: string | null; grade: number | null; course_name: string | null; submitted_at: Date | null }[]>`
        SELECT a.id, a.number, a.process_type, a.status, y.name AS year_name, c.grade, co.name AS course_name, a.submitted_at
          FROM applications a LEFT JOIN academic_years y ON y.id = a.academic_year_id LEFT JOIN school_classes c ON c.id = a.class_id
          LEFT JOIN courses co ON co.id = c.course_id
         WHERE a.student_id = ${id}::uuid AND a.status <> 'DRAFT' ORDER BY a.submitted_at DESC NULLS LAST`,
      this.db.$queryRaw<{ id: string; application_id: string; application_number: string | null; slot: string; label: string; file_name: string; size: number; created_at: Date }[]>`
        SELECT f.id, f.application_id, a.number AS application_number, f.slot, f.label, f.file_name, f.size, f.created_at
          FROM application_files f JOIN applications a ON a.id = f.application_id
         WHERE a.student_id = ${id}::uuid AND a.status <> 'DRAFT' ORDER BY f.created_at DESC`,
    ]);
    if (!s) return null;
    return {
      id: s.id,
      number: s.number,
      fullName: s.fullName,
      birthDate: iso(s.birthDate),
      gender: s.gender,
      status: s.status as StudentStatus,
      data: json(s.data),
      accountId: s.accountId,
      createdAt: s.createdAt,
      photoId: files.find((f) => f.slot === "PHOTO")?.id ?? null,
      guardians: guardians.map((g) => ({
        id: g.id,
        fullName: g.full_name,
        email: g.email,
        phone: g.phone,
        relationship: g.relationship,
        relationshipOther: g.relationship_other,
        isPrimary: g.is_primary,
        isEmergency: g.is_emergency,
        isFinancial: g.is_financial,
        canManage: g.can_manage,
        hasAccount: !!g.account_id,
        data: json(g.data),
      })),
      enrollments: enrollments.map((e) => ({
        id: e.id,
        number: e.number,
        applicationId: e.application_id,
        yearName: e.year_name,
        grade: e.grade,
        courseName: e.course_name,
        groupName: e.group_name,
        shift: e.shift as Shift | null,
        status: e.status as "ACTIVE" | "CANCELLED",
        byName: e.by_name,
        exceptionReason: e.exception_reason,
        enrolledAt: e.enrolled_at,
      })),
      applications: applications.map((a) => ({ id: a.id, number: a.number, processType: a.process_type as ProcessType, status: a.status as ApplicationStatus, yearName: a.year_name, grade: a.grade, courseName: a.course_name, submittedAt: a.submitted_at })),
      files: files.map((f) => ({ id: f.id, applicationId: f.application_id, applicationNumber: f.application_number, slot: f.slot as "PHOTO" | "DOCUMENT" | "FIELD", label: f.label, fileName: f.file_name, size: f.size, createdAt: f.created_at })),
    };
  }

  async history(subjectIds: string[], types: string[]) {
    if (!subjectIds.length) return [];
    const rows = await this.db.$queryRaw<{ type: string; details: unknown; occurred_at: Date; actor_name: string | null }[]>`
      SELECT a.type, a.details, a.occurred_at, u.full_name AS actor_name
        FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id
       WHERE a.subject_id = ANY(${subjectIds}::uuid[]) AND a.type = ANY(${types}::text[])
       ORDER BY a.occurred_at DESC LIMIT 100`;
    return rows.map((r) => ({ type: r.type, details: (r.details as Record<string, unknown> | null) ?? null, at: r.occurred_at, actorName: r.actor_name }));
  }

  async update(id: string, set: Parameters<StudentsRepository["update"]>[1], now: Date) {
    await this.db.student.update({
      where: { id },
      data: {
        ...(set.fullName ? { fullName: set.fullName } : {}),
        ...(set.birthDate ? { birthDate: new Date(`${set.birthDate}T00:00:00Z`) } : {}),
        gender: set.gender,
        data: set.data as Prisma.InputJsonValue,
        updatedAt: now,
      },
    });
  }

  async file(studentId: string, fileId: string) {
    const [f] = await this.db.$queryRaw<{ storage_key: string; mime_type: string; file_name: string }[]>`
      SELECT f.storage_key, f.mime_type, f.file_name FROM application_files f JOIN applications a ON a.id = f.application_id
       WHERE f.id = ${fileId}::uuid AND a.student_id = ${studentId}::uuid AND a.status <> 'DRAFT'`;
    return f ? { storageKey: f.storage_key, mimeType: f.mime_type, fileName: f.file_name } : null;
  }

  async accessFor(accountId: string, studentId: string) {
    const [r] = await this.db.$queryRaw<{ birth_date: Date; self: boolean; managing: boolean }[]>`
      SELECT s.birth_date, (s.account_id = ${accountId}::uuid) AS self,
             EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                      WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage) AS managing
        FROM students s WHERE s.id = ${studentId}::uuid`;
    if (!r || (!r.self && !r.managing)) return null;
    return { self: !!r.self, managingGuardian: r.managing, birthDate: iso(r.birth_date) };
  }

  async familyStudents(accountId: string) {
    const rows = await this.db.$queryRaw<
      {
        id: string;
        full_name: string;
        birth_date: Date;
        number: number | null;
        status: string;
        self: boolean;
        managing: boolean;
        enr_number: string | null;
        application_id: string | null;
        group_id: string | null;
        year_name: string | null;
        grade: number | null;
        course_name: string | null;
        group_name: string | null;
        shift: string | null;
        enrolled_at: Date | null;
      }[]
    >`
      SELECT s.id, s.full_name, s.birth_date, s.number, s.status,
             (s.account_id IS NOT DISTINCT FROM ${accountId}::uuid) AS self,
             EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
                      WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage) AS managing,
             e.number AS enr_number, e.application_id, e.group_id, y.name AS year_name, c.grade, co.name AS course_name, g.name AS group_name, e.shift, e.enrolled_at
        FROM students s
        LEFT JOIN LATERAL (SELECT * FROM enrollments e WHERE e.student_id = s.id AND e.status = 'ACTIVE' ORDER BY e.enrolled_at DESC LIMIT 1) e ON TRUE
        LEFT JOIN academic_years y ON y.id = e.academic_year_id
        LEFT JOIN school_classes c ON c.id = e.class_id
        LEFT JOIN courses co ON co.id = c.course_id
        LEFT JOIN class_groups g ON g.id = e.group_id
       WHERE s.account_id = ${accountId}::uuid
          OR EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = s.id AND g.account_id = ${accountId}::uuid AND sg.can_manage)
       ORDER BY s.full_name`;
    return rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      birthDate: iso(r.birth_date),
      number: r.number,
      status: r.status as StudentStatus,
      self: !!r.self,
      managing: !!r.managing,
      enrollment:
        r.enr_number && r.year_name && r.grade !== null && r.enrolled_at
          ? { number: r.enr_number, applicationId: r.application_id, groupId: r.group_id, yearName: r.year_name, grade: r.grade, courseName: r.course_name, groupName: r.group_name, shift: r.shift as Shift | null, enrolledAt: r.enrolled_at }
          : null,
    }));
  }

  async currentGroup(studentId: string) {
    const [r] = await this.db.$queryRaw<{ group_id: string }[]>`
      SELECT e.group_id FROM enrollments e
       WHERE e.student_id = ${studentId}::uuid AND e.status = 'ACTIVE' AND e.group_id IS NOT NULL
       ORDER BY e.enrolled_at DESC LIMIT 1`;
    return r?.group_id ?? null;
  }

  async groupStudents(groupId: string) {
    const rows = await this.db.$queryRaw<
      { id: string; number: number | null; full_name: string; birth_date: Date; gender: string | null; enrollment_number: string; photo_id: string | null; guardian_name: string | null; guardian_phone: string | null; relationship: string | null; relationship_other: string | null }[]
    >`
      SELECT s.id, s.number, s.full_name, s.birth_date, s.gender, e.number AS enrollment_number,
             (SELECT fi.id FROM application_files fi JOIN applications a ON a.id = fi.application_id
               WHERE a.student_id = s.id AND fi.slot = 'PHOTO' AND a.status <> 'DRAFT' ORDER BY fi.created_at DESC LIMIT 1) AS photo_id,
             gu.full_name AS guardian_name, gu.phone AS guardian_phone, gu.relationship, gu.relationship_other
        FROM enrollments e JOIN students s ON s.id = e.student_id
        LEFT JOIN LATERAL (SELECT gx.full_name, gx.phone, sg.relationship, sg.relationship_other FROM student_guardians sg JOIN guardians gx ON gx.id = sg.guardian_id
                            WHERE sg.student_id = s.id ORDER BY sg.is_primary DESC LIMIT 1) gu ON TRUE
       WHERE e.group_id = ${groupId}::uuid AND e.status = 'ACTIVE'
       ORDER BY s.full_name`;
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      fullName: r.full_name,
      birthDate: iso(r.birth_date),
      gender: r.gender,
      enrollmentNumber: r.enrollment_number,
      photoId: r.photo_id,
      guardianName: r.guardian_name,
      guardianPhone: r.guardian_phone,
      guardianRelationship: r.relationship === "Outro" ? (r.relationship_other ?? "Outro") : r.relationship,
    }));
  }

  async groupPhoto(groupId: string, studentId: string) {
    const [f] = await this.db.$queryRaw<{ storage_key: string; mime_type: string; file_name: string }[]>`
      SELECT fi.storage_key, fi.mime_type, fi.file_name FROM application_files fi JOIN applications a ON a.id = fi.application_id
       WHERE a.student_id = ${studentId}::uuid AND fi.slot = 'PHOTO' AND a.status <> 'DRAFT'
         AND EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = ${studentId}::uuid AND e.group_id = ${groupId}::uuid AND e.status = 'ACTIVE')
       ORDER BY fi.created_at DESC LIMIT 1`;
    return f ? { storageKey: f.storage_key, mimeType: f.mime_type, fileName: f.file_name } : null;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
