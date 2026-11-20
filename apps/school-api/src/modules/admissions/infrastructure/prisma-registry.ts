import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { EnrollmentListRow, GuardianDetailRow, GuardianListRow, RegistryRepository, StatsRow } from "../application/Registry";
import type { ApplicationStatus, Entry, Shift } from "../domain/applications";
import type { ProcessType } from "../domain/settings";
import type { StudentStatus } from "../domain/students";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => (v && typeof v === "object" ? (v as Entry) : {});
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Secretaria · registos (matrículas, encarregados, números), em SQL: com a BD no Neon cada ida conta. */
export class PrismaRegistryRepository implements RegistryRepository {
  constructor(private readonly db: PrismaClient) {}

  async enrollments(f: Parameters<RegistryRepository["enrollments"]>[0]) {
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.yearId) conds.push(Prisma.sql`e.academic_year_id = ${f.yearId}::uuid`);
    if (f.classId) conds.push(Prisma.sql`e.class_id = ${f.classId}::uuid`);
    if (f.status) conds.push(Prisma.sql`e.status = ${f.status}`);
    if (f.q) conds.push(Prisma.sql`(s.full_name ILIKE ${like(f.q)} OR e.number ILIKE ${like(f.q)} OR (${/^\d+$/.test(f.q)} AND s.number::text = ${f.q.replace(/^0+/, "")}))`);
    const rows = await this.db.$queryRaw<
      {
        id: string;
        number: string;
        application_id: string | null;
        student_id: string;
        student_name: string;
        student_number: number | null;
        year_name: string;
        grade: number;
        course_name: string | null;
        group_name: string | null;
        shift: string | null;
        status: string;
        by_kind: string;
        by_name: string | null;
        process_type: string | null;
        exception: boolean;
        enrolled_at: Date;
        total: bigint;
      }[]
    >`
      SELECT e.id, e.number, e.application_id, s.id AS student_id, s.full_name AS student_name, s.number AS student_number,
             y.name AS year_name, c.grade, co.name AS course_name, g.name AS group_name, e.shift, e.status, e.by_kind, e.by_name,
             a.process_type, (e.exception_reason IS NOT NULL) AS exception, e.enrolled_at, count(*) OVER () AS total
        FROM enrollments e JOIN students s ON s.id = e.student_id
        JOIN academic_years y ON y.id = e.academic_year_id JOIN school_classes c ON c.id = e.class_id
        LEFT JOIN courses co ON co.id = c.course_id LEFT JOIN class_groups g ON g.id = e.group_id
        LEFT JOIN applications a ON a.id = e.application_id
       WHERE ${Prisma.join(conds, " AND ")}
       ORDER BY e.enrolled_at DESC
       LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map(
        (r): EnrollmentListRow => ({
          id: r.id,
          number: r.number,
          applicationId: r.application_id,
          studentId: r.student_id,
          studentName: r.student_name,
          studentNumber: r.student_number,
          yearName: r.year_name,
          grade: r.grade,
          courseName: r.course_name,
          groupName: r.group_name,
          shift: r.shift as Shift | null,
          status: r.status as "ACTIVE" | "CANCELLED",
          byKind: r.by_kind as EnrollmentListRow["byKind"],
          byName: r.by_name,
          processType: r.process_type as ProcessType | null,
          exception: !!r.exception,
          enrolledAt: r.enrolled_at,
        }),
      ),
    };
  }

  async enrollmentYears() {
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

  async guardians(f: { q?: string; page: number; pageSize: number }) {
    const cond = f.q
      ? Prisma.sql`(g.full_name ILIKE ${like(f.q)} OR g.email ILIKE ${like(f.q)} OR g.phone ILIKE ${like(f.q)}
          OR EXISTS (SELECT 1 FROM student_guardians x JOIN students xs ON xs.id = x.student_id WHERE x.guardian_id = g.id AND xs.full_name ILIKE ${like(f.q)}))`
      : Prisma.sql`TRUE`;
    const rows = await this.db.$queryRaw<{ id: string; full_name: string; email: string | null; phone: string | null; has_account: boolean; students: unknown; enrolled: number; total: bigint }[]>`
      SELECT g.id, g.full_name, g.email, g.phone, (g.account_id IS NOT NULL) AS has_account,
             COALESCE((SELECT json_agg(json_build_object('id', s.id, 'fullName', s.full_name, 'relationship', CASE WHEN sg.relationship = 'Outro' THEN COALESCE(sg.relationship_other, 'Outro') ELSE sg.relationship END, 'isPrimary', sg.is_primary) ORDER BY s.full_name)
                         FROM student_guardians sg JOIN students s ON s.id = sg.student_id WHERE sg.guardian_id = g.id), '[]') AS students,
             (SELECT count(*)::int FROM student_guardians sg JOIN students s ON s.id = sg.student_id WHERE sg.guardian_id = g.id AND s.status = 'ENROLLED') AS enrolled,
             count(*) OVER () AS total
        FROM guardians g
       WHERE EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.guardian_id = g.id) AND ${cond}
       ORDER BY g.full_name
       LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map((r): GuardianListRow => ({ id: r.id, fullName: r.full_name, email: r.email, phone: r.phone, hasAccount: !!r.has_account, students: r.students as GuardianListRow["students"], enrolled: r.enrolled })),
    };
  }

  async guardian(id: string): Promise<GuardianDetailRow | null> {
    const [g, students] = await Promise.all([
      this.db.guardian.findUnique({ where: { id }, include: { account: { select: { email: true, kind: true, createdAt: true, lastLoginAt: true } } } }),
      this.db.$queryRaw<
        {
          id: string;
          full_name: string;
          number: number | null;
          birth_date: Date;
          status: string;
          relationship: string;
          relationship_other: string | null;
          is_primary: boolean;
          is_emergency: boolean;
          is_financial: boolean;
          can_manage: boolean;
          year_name: string | null;
          grade: number | null;
          course_name: string | null;
          group_name: string | null;
        }[]
      >`
        SELECT s.id, s.full_name, s.number, s.birth_date, s.status, sg.relationship, sg.relationship_other, sg.is_primary, sg.is_emergency, sg.is_financial, sg.can_manage,
               e.year_name, e.grade, e.course_name, e.group_name
          FROM student_guardians sg JOIN students s ON s.id = sg.student_id
          LEFT JOIN LATERAL (SELECT y.name AS year_name, c.grade, co.name AS course_name, gr.name AS group_name
                               FROM enrollments e JOIN academic_years y ON y.id = e.academic_year_id JOIN school_classes c ON c.id = e.class_id
                               LEFT JOIN courses co ON co.id = c.course_id LEFT JOIN class_groups gr ON gr.id = e.group_id
                              WHERE e.student_id = s.id AND e.status = 'ACTIVE' ORDER BY y.starts_on DESC LIMIT 1) e ON TRUE
         WHERE sg.guardian_id = ${id}::uuid ORDER BY s.full_name`,
    ]);
    if (!g) return null;
    return {
      id: g.id,
      fullName: g.fullName,
      email: g.email,
      phone: g.phone,
      data: json(g.data),
      createdAt: g.createdAt,
      account: g.account ? { email: g.account.email, kind: g.account.kind, createdAt: g.account.createdAt, lastLoginAt: g.account.lastLoginAt } : null,
      students: students.map((s) => ({
        id: s.id,
        fullName: s.full_name,
        number: s.number,
        birthDate: iso(s.birth_date),
        status: s.status as StudentStatus,
        relationship: s.relationship,
        relationshipOther: s.relationship_other,
        isPrimary: s.is_primary,
        isEmergency: s.is_emergency,
        isFinancial: s.is_financial,
        canManage: s.can_manage,
        current: s.year_name && s.grade !== null ? { yearName: s.year_name, grade: s.grade, courseName: s.course_name, groupName: s.group_name } : null,
      })),
    };
  }

  async stats(yearId: string | null): Promise<(StatsRow & { year: { id: string; name: string } | null }) | null> {
    const years = await this.db.$queryRaw<{ id: string; name: string; starts_on: Date; ends_on: Date; status: string; has: boolean }[]>`
      SELECT y.id, y.name, y.starts_on, y.ends_on, y.status, EXISTS (SELECT 1 FROM enrollments e WHERE e.academic_year_id = y.id AND e.status = 'ACTIVE') AS has
        FROM academic_years y ORDER BY y.starts_on DESC`;
    const list = years.map((y) => ({ id: y.id, name: y.name, startsOn: iso(y.starts_on) }));
    // o pedido; senão o ano em curso; senão o que ainda não terminou e começa primeiro (não o ano seguinte
    // criado para as renovações); senão o mais recente com matrículas; senão o mais recente
    const now = new Date();
    const pick =
      years.find((y) => y.id === yearId) ??
      years.find((y) => y.status === "ACTIVE") ??
      [...years].reverse().find((y) => y.status !== "CLOSED" && y.ends_on >= now) ??
      years.find((y) => y.has) ??
      years[0];
    if (!pick) return { year: null, years: list, byGrade: [], byMonth: [], byGender: [], applications: [], renewal: null };
    const previous = years.find((y) => y.starts_on < pick.starts_on);
    const [byGrade, byMonth, byGender, applications, renewal] = await Promise.all([
      this.db.$queryRaw<{ grade: number; course_name: string | null; enrolled: number; capacity: number }[]>`
        SELECT c.grade, co.name AS course_name,
               (SELECT count(*)::int FROM enrollments e WHERE e.class_id = c.id AND e.status = 'ACTIVE') AS enrolled,
               COALESCE((SELECT sum(g.capacity)::int FROM class_groups g WHERE g.class_id = c.id), 0) AS capacity
          FROM school_classes c LEFT JOIN courses co ON co.id = c.course_id
         WHERE c.academic_year_id = ${pick.id}::uuid ORDER BY c.grade, co.name NULLS FIRST`,
      this.db.$queryRaw<{ month: string; fresh: number; renewals: number }[]>`
        SELECT to_char(e.enrolled_at AT TIME ZONE 'Africa/Luanda', 'YYYY-MM') AS month,
               count(*) FILTER (WHERE a.process_type IS DISTINCT FROM 'RENOVACAO')::int AS fresh,
               count(*) FILTER (WHERE a.process_type = 'RENOVACAO')::int AS renewals
          FROM enrollments e LEFT JOIN applications a ON a.id = e.application_id
         WHERE e.academic_year_id = ${pick.id}::uuid AND e.status = 'ACTIVE'
         GROUP BY 1 ORDER BY 1`,
      this.db.$queryRaw<{ gender: string | null; count: number }[]>`
        SELECT s.gender, count(*)::int AS count FROM enrollments e JOIN students s ON s.id = e.student_id
         WHERE e.academic_year_id = ${pick.id}::uuid AND e.status = 'ACTIVE' GROUP BY s.gender ORDER BY 2 DESC`,
      this.db.$queryRaw<{ status: string; process_type: string; count: number }[]>`
        SELECT a.status, a.process_type, count(*)::int AS count FROM applications a
         WHERE a.academic_year_id = ${pick.id}::uuid GROUP BY 1, 2`,
      previous
        ? this.db.$queryRaw<{ previous: number; renewed: number }[]>`
            SELECT count(*)::int AS previous,
                   count(*) FILTER (WHERE EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.student_id = e.student_id AND e2.academic_year_id = ${pick.id}::uuid AND e2.status = 'ACTIVE'))::int AS renewed
              FROM enrollments e WHERE e.academic_year_id = ${previous.id}::uuid AND e.status = 'ACTIVE'`
        : Promise.resolve([] as { previous: number; renewed: number }[]),
    ]);
    return {
      year: { id: pick.id, name: pick.name },
      years: list,
      byGrade: byGrade.map((r) => ({ grade: r.grade, courseName: r.course_name, enrolled: r.enrolled, capacity: r.capacity })),
      byMonth,
      byGender,
      applications: applications.map((r) => ({ status: r.status as ApplicationStatus, processType: r.process_type as ProcessType, count: r.count })),
      renewal: renewal[0] && renewal[0].previous > 0 ? renewal[0] : null,
    };
  }
}
