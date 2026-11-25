import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { ExpenseData, ExpenseMethod, ExpenseStatus } from "../domain/expenses";

export interface CategoryRow {
  id: string;
  name: string;
  archived: boolean;
  used: number;
}
export interface ExpenseRow {
  id: string;
  number: number;
  categoryId: string;
  categoryName: string;
  description: string;
  supplier: string | null;
  documentNumber: string | null;
  amount: number;
  issuedOn: string;
  dueOn: string | null;
  note: string | null;
  status: ExpenseStatus;
  paidOn: string | null;
  method: ExpenseMethod | null;
  bankAccountId: string | null;
  bankName: string | null;
  transactionNumber: string | null;
  proofName: string | null;
  proofMimeType: string | null;
  proofSize: number | null;
  proofStorageKey: string | null;
  createdByName: string | null;
  createdAt: Date;
  paidByName: string | null;
  cancelReason: string | null;
}
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || (e.meta as { code?: string } | undefined)?.code === "23505");
const EXPENSE = Prisma.raw(`
  SELECT e.id, e.number, e.category_id AS "categoryId", c.name AS "categoryName", e.description, e.supplier, e.document_number AS "documentNumber", e.amount, to_char(e.issued_on, 'YYYY-MM-DD') AS "issuedOn",
         to_char(e.due_on, 'YYYY-MM-DD') AS "dueOn", e.note, e.status, to_char(e.paid_on, 'YYYY-MM-DD') AS "paidOn", e.method, e.bank_account_id AS "bankAccountId", e.bank_name AS "bankName",
         e.transaction_number AS "transactionNumber", e.proof_name AS "proofName", e.proof_mime_type AS "proofMimeType", e.proof_size AS "proofSize", e.proof_storage_key AS "proofStorageKey",
         cu.full_name AS "createdByName", e.created_at AS "createdAt", pu.full_name AS "paidByName", e.cancel_reason AS "cancelReason"
    FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN school_users cu ON cu.id = e.created_by_id LEFT JOIN school_users pu ON pu.id = e.paid_by_id`);

export class PrismaExpensesRepository {
  constructor(private readonly db: PrismaClient) {}

  categories(): Promise<CategoryRow[]> {
    return this.db.$queryRaw<CategoryRow[]>`
      SELECT c.id, c.name, c.archived_at IS NOT NULL AS archived, (SELECT count(*)::int FROM expenses e WHERE e.category_id = c.id) AS used FROM expense_categories c ORDER BY c.archived_at IS NOT NULL, c.position, lower(c.name)`;
  }
  /** Junta categorias (as que já existem com esse nome ficam, e voltam a ativas). */
  async addCategories(names: string[], now: Date) {
    const rows = names.map((name, i) => ({ id: randomUUID(), name, p: i }));
    await this.db.$executeRaw`
      INSERT INTO expense_categories (id, name, position, created_at)
      SELECT x.id, x.name, (SELECT coalesce(max(position), 0) FROM expense_categories) + x.p + 1, ${now} FROM json_to_recordset(${JSON.stringify(rows)}::json) AS x(id uuid, name text, p int)
      ON CONFLICT (lower(name)) DO UPDATE SET archived_at = NULL`;
  }
  async renameCategory(id: string, name: string): Promise<"ok" | "duplicate" | "missing"> {
    try {
      return (await this.db.$executeRaw`UPDATE expense_categories SET name = ${name} WHERE id = ${id}::uuid`) === 1 ? "ok" : "missing";
    } catch (e) {
      if (isUnique(e)) return "duplicate";
      throw e;
    }
  }
  /** Apaga se nunca foi usada; senão arquiva (ou volta a ativar). */
  async removeCategory(id: string, now: Date): Promise<"removed" | "archived" | "missing"> {
    if ((await this.db.$executeRaw`DELETE FROM expense_categories c WHERE c.id = ${id}::uuid AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.category_id = c.id)`) === 1) return "removed";
    return (await this.db.$executeRaw`UPDATE expense_categories SET archived_at = ${now} WHERE id = ${id}::uuid AND archived_at IS NULL`) === 1 ? "archived" : "missing";
  }
  async restoreCategory(id: string) {
    return (await this.db.$executeRaw`UPDATE expense_categories SET archived_at = NULL WHERE id = ${id}::uuid`) === 1;
  }

  async byId(id: string): Promise<ExpenseRow | null> {
    return (await this.db.$queryRaw<ExpenseRow[]>`${EXPENSE} WHERE e.id = ${id}::uuid`)[0] ?? null;
  }

  async list(f: { status?: string; categoryId?: string; month?: string; q?: string; page: number; pageSize: number; today: string }) {
    const where = Prisma.sql`true
      ${f.status === "OVERDUE" ? Prisma.sql`AND e.status = 'PENDING' AND e.due_on < ${f.today}::date` : f.status ? Prisma.sql`AND e.status = ${f.status}` : Prisma.empty}
      ${f.categoryId ? Prisma.sql`AND e.category_id = ${f.categoryId}::uuid` : Prisma.empty}
      ${f.month ? Prisma.sql`AND to_char(coalesce(e.paid_on, e.due_on, e.issued_on), 'YYYY-MM') = ${f.month}` : Prisma.empty}
      ${f.q ? Prisma.sql`AND (e.description ILIKE ${`%${f.q}%`} OR e.supplier ILIKE ${`%${f.q}%`} OR e.document_number ILIKE ${`%${f.q}%`} OR ('DES-' || lpad(e.number::text, 6, '0')) ILIKE ${`%${f.q}%`})` : Prisma.empty}`;
    const [items, [sum], counts] = await Promise.all([
      this.db.$queryRaw<ExpenseRow[]>`${EXPENSE} WHERE ${where} ORDER BY ${f.status === "PENDING" || f.status === "OVERDUE" ? Prisma.sql`e.due_on NULLS LAST, e.number` : Prisma.sql`coalesce(e.paid_on, e.issued_on) DESC, e.number DESC`} LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
      this.db.$queryRaw<{ n: number; total: number }[]>`SELECT count(*)::int AS n, coalesce(sum(e.amount) FILTER (WHERE e.status <> 'CANCELLED' OR ${f.status === "CANCELLED"}), 0)::float8 AS total FROM expenses e WHERE ${where}`,
      this.db.$queryRaw<{ status: ExpenseStatus; n: number; overdue: number }[]>`SELECT status, count(*)::int AS n, count(*) FILTER (WHERE status = 'PENDING' AND due_on < ${f.today}::date)::int AS overdue FROM expenses GROUP BY status`,
    ]);
    return { items, total: sum.n, amount: sum.total, counts };
  }

  /** Outra despesa (não anulada) com o mesmo fornecedor e o mesmo documento. */
  async duplicate(supplier: string, documentNumber: string, exceptId: string | null) {
    const [r] = await this.db.$queryRaw<{ number: number }[]>`
      SELECT number FROM expenses WHERE status <> 'CANCELLED' AND lower(supplier) = lower(${supplier}) AND lower(document_number) = lower(${documentNumber}) AND id IS DISTINCT FROM ${exceptId}::uuid LIMIT 1`;
    return r?.number ?? null;
  }

  async create(id: string, d: ExpenseData, actorId: string, now: Date) {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO expenses (id, category_id, description, supplier, document_number, amount, issued_on, due_on, note, created_by_id, created_at, updated_at)
        VALUES (${id}::uuid, ${d.categoryId}::uuid, ${d.description}, ${d.supplier}, ${d.documentNumber}, ${d.amount}, ${d.issuedOn}::date, ${d.dueOn}::date, ${d.note}, ${actorId}::uuid, ${now}, ${now})`;
      await this.record(tx, "EXPENSE_CREATED", id, actorId, { after: d }, now);
    });
  }

  /** Muda a despesa se ainda estiver no estado esperado; tudo na mesma transação com o histórico. */
  async update(id: string, from: ExpenseStatus[], set: Prisma.Sql, type: string, actorId: string, details: Record<string, unknown>, now: Date) {
    return this.db.$transaction(async (tx) => {
      const n = await tx.$executeRaw`UPDATE expenses SET ${set}, updated_at = ${now} WHERE id = ${id}::uuid AND status = ANY(${from})`;
      if (n !== 1) return false;
      await this.record(tx, type, id, actorId, details, now);
      return true;
    });
  }
  edit = (id: string, d: ExpenseData, from: ExpenseStatus[], actorId: string, before: unknown, now: Date) =>
    this.update(
      id,
      from,
      Prisma.sql`category_id = ${d.categoryId}::uuid, description = ${d.description}, supplier = ${d.supplier}, document_number = ${d.documentNumber}, amount = ${d.amount}, issued_on = ${d.issuedOn}::date, due_on = ${d.dueOn}::date, note = ${d.note}`,
      "EXPENSE_CHANGED",
      actorId,
      { before, after: d },
      now,
    );
  pay = (id: string, p: { paidOn: string; method: ExpenseMethod; bankAccountId: string | null; transactionNumber: string | null }, bankName: string | null, actorId: string, now: Date) =>
    this.update(
      id,
      ["PENDING"],
      Prisma.sql`status = 'PAID', paid_on = ${p.paidOn}::date, method = ${p.method}, bank_account_id = ${p.bankAccountId}::uuid, bank_name = ${bankName}, transaction_number = ${p.transactionNumber}, paid_by_id = ${actorId}::uuid`,
      "EXPENSE_PAID",
      actorId,
      { paidOn: p.paidOn, method: p.method, bank: bankName, transaction: p.transactionNumber },
      now,
    );
  unpay = (id: string, reason: string, actorId: string, now: Date) =>
    this.update(id, ["PAID"], Prisma.sql`status = 'PENDING', paid_on = NULL, method = NULL, bank_account_id = NULL, bank_name = NULL, transaction_number = NULL, paid_by_id = NULL`, "EXPENSE_UNPAID", actorId, { reason }, now);
  cancel = (id: string, reason: string, actorId: string, now: Date) =>
    this.update(id, ["PENDING"], Prisma.sql`status = 'CANCELLED', cancel_reason = ${reason}, cancelled_by_id = ${actorId}::uuid, cancelled_at = ${now}`, "EXPENSE_CANCELLED", actorId, { reason }, now);
  attach = (id: string, f: { name: string; mimeType: string; size: number; sha256: string; storageKey: string }, actorId: string, now: Date) =>
    this.update(id, ["PENDING", "PAID"], Prisma.sql`proof_name = ${f.name}, proof_mime_type = ${f.mimeType}, proof_size = ${f.size}, proof_sha256 = ${f.sha256}, proof_storage_key = ${f.storageKey}`, "EXPENSE_PROOF", actorId, { file: f.name, sha256: f.sha256 }, now);

  history(id: string) {
    return this.db.$queryRaw<{ at: Date; type: string; by: string | null; details: Record<string, unknown> | null }[]>`
      SELECT a.occurred_at AS at, a.type, u.full_name AS by, a.details FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id WHERE a.subject_id = ${id}::uuid ORDER BY a.occurred_at`;
  }
  banks() {
    return this.db.$queryRaw<{ id: string; bankName: string; iban: string }[]>`SELECT id, bank_name AS "bankName", iban FROM bank_accounts WHERE active ORDER BY position, bank_name`;
  }
  async log(type: string, subjectId: string, actorId: string, details: Record<string, unknown>, now: Date) {
    await this.record(this.db, type, subjectId, actorId, details, now);
  }
  private async record(db: PrismaClient | Prisma.TransactionClient, type: string, subjectId: string, actorId: string, details: Record<string, unknown>, now: Date) {
    await db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
