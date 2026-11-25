import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { LateFeeKind } from "../domain/pricing";

export interface YearRow {
  id: string;
  name: string;
  status: string;
  startsOn: string;
  endsOn: string;
}
type Sum = { key: string; n: number; total: number };
/** por pagar e fora de um pagamento em validação */
const IDLE = Prisma.raw(`c.status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = c.id AND p.status = 'SUBMITTED')`);
const CLASS = Prisma.raw(`
  LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id LEFT JOIN enrollments e ON e.id = c.enrollment_id OR (c.enrollment_id IS NULL AND e.application_id = c.application_id)
  LEFT JOIN school_classes cl ON cl.id = coalesce(e.class_id, a.class_id) LEFT JOIN courses co ON co.id = cl.course_id LEFT JOIN class_groups g ON g.id = e.group_id`);

/** Números das finanças (só leitura). "Recebido" é sempre o que as Finanças validaram, na data em que foi pago. */
export class PrismaFinanceReports {
  constructor(private readonly db: PrismaClient) {}

  years(): Promise<YearRow[]> {
    return this.db.$queryRaw<YearRow[]>`SELECT id, name, status, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn" FROM academic_years ORDER BY starts_on DESC`;
  }
  classes(yearId: string) {
    return this.db.$queryRaw<{ id: string; grade: number; courseName: string | null }[]>`
      SELECT cl.id, cl.grade, co.name AS "courseName" FROM school_classes cl LEFT JOIN courses co ON co.id = cl.course_id WHERE cl.academic_year_id = ${yearId}::uuid ORDER BY cl.grade, co.name`;
  }

  // ------------------------------------------------------------------ receitas

  receivedBy(by: "month" | "method" | "bank", from: string, to: string): Promise<Sum[]> {
    const key = { month: Prisma.sql`to_char(p.paid_on, 'YYYY-MM')`, method: Prisma.sql`p.method`, bank: Prisma.sql`p.bank_name || ' · ' || p.bank_iban` }[by];
    return this.db.$queryRaw<Sum[]>`SELECT ${key} AS key, count(*)::int AS n, coalesce(sum(p.total), 0)::float8 AS total FROM payments p WHERE p.status = 'VALIDATED' AND p.paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY 1`;
  }
  receivedByKind(from: string, to: string): Promise<Sum[]> {
    return this.db.$queryRaw<Sum[]>`
      SELECT c.kind AS key, count(*)::int AS n, coalesce(sum(pi.amount + pi.late_fee), 0)::float8 AS total FROM payments p JOIN payment_items pi ON pi.payment_id = p.id JOIN charges c ON c.id = pi.charge_id
       WHERE p.status = 'VALIDATED' AND p.paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY 3 DESC`;
  }
  payments(from: string, to: string, limit: number) {
    return this.db.$queryRaw<{ number: number; paidOn: string; students: string; items: string; method: string; bankName: string; transaction: string; lateFee: number; total: number }[]>`
      SELECT p.number, to_char(p.paid_on, 'YYYY-MM-DD') AS "paidOn", p.method, p.bank_name AS "bankName", p.transaction_number AS transaction, p.total,
             (SELECT coalesce(sum(pi.late_fee), 0)::int FROM payment_items pi WHERE pi.payment_id = p.id) AS "lateFee",
             (SELECT string_agg(DISTINCT coalesce(st.full_name, a.student_data->>'fullName', 'Aluno'), ', ') FROM payment_items pi JOIN charges c ON c.id = pi.charge_id LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id WHERE pi.payment_id = p.id) AS students,
             (SELECT string_agg(c.label, ', ' ORDER BY c.due_on NULLS FIRST, c.label) FROM payment_items pi JOIN charges c ON c.id = pi.charge_id WHERE pi.payment_id = p.id) AS items
        FROM payments p WHERE p.status = 'VALIDATED' AND p.paid_on BETWEEN ${from}::date AND ${to}::date ORDER BY p.paid_on, p.number LIMIT ${limit}`;
  }
  async waiting() {
    const [r] = await this.db.$queryRaw<{ n: number; total: number }[]>`SELECT count(*)::int AS n, coalesce(sum(total), 0)::float8 AS total FROM payments WHERE status = 'SUBMITTED'`;
    return r;
  }

  // ------------------------------------------------------------------ cobranças

  async chargeTotals(yearId: string, today: string) {
    const [r] = await this.db.$queryRaw<{ open: number; overdue: number; overdueCharges: number; overdueStudents: number; waived: number }[]>`
      SELECT coalesce(sum(c.amount) FILTER (WHERE ${IDLE}), 0)::float8 AS open, coalesce(sum(c.amount) FILTER (WHERE ${IDLE} AND c.due_on < ${today}::date), 0)::float8 AS overdue,
             count(*) FILTER (WHERE ${IDLE} AND c.due_on < ${today}::date)::int AS "overdueCharges", count(DISTINCT c.student_id) FILTER (WHERE ${IDLE} AND c.due_on < ${today}::date)::int AS "overdueStudents",
             coalesce(sum(c.amount) FILTER (WHERE c.status = 'WAIVED'), 0)::float8 AS waived
        FROM charges c WHERE c.academic_year_id = ${yearId}::uuid AND c.status <> 'VOID'`;
    return r;
  }
  /** Propinas de cada mês: o que se esperava (sem as isentas), o que já foi pago e o que está em atraso. */
  monthly(yearId: string, today: string) {
    return this.db.$queryRaw<{ month: string; expected: number; paid: number; overdue: number }[]>`
      SELECT c.month, coalesce(sum(c.amount) FILTER (WHERE c.status IN ('OPEN', 'PAID')), 0)::float8 AS expected, coalesce(sum(c.amount) FILTER (WHERE c.status = 'PAID'), 0)::float8 AS paid,
             coalesce(sum(c.amount) FILTER (WHERE ${IDLE} AND c.due_on < ${today}::date), 0)::float8 AS overdue
        FROM charges c WHERE c.kind = 'PROPINA' AND c.academic_year_id = ${yearId}::uuid AND c.status <> 'VOID' GROUP BY c.month ORDER BY c.month`;
  }
  overdueByClass(yearId: string, today: string) {
    return this.db.$queryRaw<{ classId: string | null; grade: number | null; courseName: string | null; students: number; n: number; total: number }[]>`
      SELECT cl.id AS "classId", cl.grade, co.name AS "courseName", count(DISTINCT coalesce(c.student_id, c.application_id))::int AS students, count(*)::int AS n, sum(c.amount)::float8 AS total
        FROM charges c ${CLASS} WHERE c.academic_year_id = ${yearId}::uuid AND ${IDLE} AND c.due_on < ${today}::date GROUP BY cl.id, cl.grade, co.name ORDER BY total DESC`;
  }
  debts(yearId: string, classId: string | null, limit: number) {
    return this.db.$queryRaw<{ student: string; number: number | null; grade: number | null; courseName: string | null; groupName: string | null; label: string; amount: number; dueOn: string | null; planKind: LateFeeKind | null; planValue: number | null; studentKey: string }[]>`
      SELECT coalesce(st.full_name, a.student_data->>'fullName', 'Aluno') AS student, st.number, cl.grade, co.name AS "courseName", g.name AS "groupName", c.label, c.amount, to_char(c.due_on, 'YYYY-MM-DD') AS "dueOn",
             fp.late_fee_kind AS "planKind", fp.late_fee_value AS "planValue", coalesce(c.student_id, c.application_id)::text AS "studentKey"
        FROM charges c ${CLASS} LEFT JOIN fee_plans fp ON fp.academic_year_id = c.academic_year_id AND c.kind = 'PROPINA'
       WHERE c.academic_year_id = ${yearId}::uuid AND ${IDLE} ${classId ? Prisma.sql`AND cl.id = ${classId}::uuid` : Prisma.empty} ORDER BY cl.grade, co.name, g.name, student, c.due_on LIMIT ${limit}`;
  }
  waivers(from: string, to: string, limit: number) {
    return this.db.$queryRaw<{ day: string; student: string; grade: number | null; courseName: string | null; label: string; reason: string | null; by: string | null; amount: number }[]>`
      SELECT to_char(c.decided_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda', 'YYYY-MM-DD') AS day, coalesce(st.full_name, a.student_data->>'fullName', 'Aluno') AS student, cl.grade, co.name AS "courseName", c.label,
             c.waive_reason AS reason, u.full_name AS by, c.amount
        FROM charges c ${CLASS} LEFT JOIN school_users u ON u.id = c.decided_by_id
       WHERE c.status = 'WAIVED' AND (c.decided_at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Luanda')::date BETWEEN ${from}::date AND ${to}::date ORDER BY c.decided_at LIMIT ${limit}`;
  }

  // ------------------------------------------------------------------ despesas

  expensesBy(by: "month" | "category", from: string, to: string): Promise<Sum[]> {
    const key = by === "month" ? Prisma.sql`to_char(e.paid_on, 'YYYY-MM')` : Prisma.sql`k.name`;
    return this.db.$queryRaw<Sum[]>`SELECT ${key} AS key, count(*)::int AS n, coalesce(sum(e.amount), 0)::float8 AS total FROM expenses e JOIN expense_categories k ON k.id = e.category_id WHERE e.status = 'PAID' AND e.paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY ${by === "month" ? Prisma.sql`1` : Prisma.sql`3 DESC`}`;
  }
  expenses(from: string, to: string, limit: number) {
    return this.db.$queryRaw<{ number: number; paidOn: string; category: string; description: string; supplier: string | null; documentNumber: string | null; method: string; bankName: string | null; amount: number }[]>`
      SELECT e.number, to_char(e.paid_on, 'YYYY-MM-DD') AS "paidOn", k.name AS category, e.description, e.supplier, e.document_number AS "documentNumber", e.method, e.bank_name AS "bankName", e.amount
        FROM expenses e JOIN expense_categories k ON k.id = e.category_id WHERE e.status = 'PAID' AND e.paid_on BETWEEN ${from}::date AND ${to}::date ORDER BY e.paid_on, e.number LIMIT ${limit}`;
  }
  async expensesWaiting(today: string) {
    const [r] = await this.db.$queryRaw<{ n: number; total: number; overdue: number }[]>`SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float8 AS total, coalesce(sum(amount) FILTER (WHERE due_on < ${today}::date), 0)::float8 AS overdue FROM expenses WHERE status = 'PENDING'`;
    return r;
  }
}
