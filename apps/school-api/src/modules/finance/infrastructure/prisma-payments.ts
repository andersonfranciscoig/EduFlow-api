import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import type { ChargeKind, ChargeStatus, PaymentMethod, PaymentStatus } from "../domain/payments";
import type { LateFeeKind } from "../domain/pricing";

export interface SettingsRow {
  transferEnabled: boolean;
  activeSince: Date | null;
  requireApplication: boolean;
  requireEnrollment: boolean;
  monthlyFrom: string | null;
  validationHours: number;
  instructions: string | null;
}
export interface AccountRow {
  id: string;
  bankName: string;
  holder: string;
  accountNumber: string | null;
  iban: string;
  notes: string | null;
  active: boolean;
  position: number;
  used: boolean;
}
export interface ChargeRow {
  id: string;
  kind: ChargeKind;
  label: string;
  amount: number;
  yearId: string;
  yearName: string;
  studentId: string | null;
  studentName: string;
  studentNumber: number | null;
  applicationId: string | null;
  applicationNumber: string | null;
  enrollmentId: string | null;
  grade: number | null;
  courseName: string | null;
  groupName: string | null;
  month: string | null;
  dueOn: string | null;
  status: ChargeStatus;
  paidAt: Date | null;
  waiveReason: string | null;
  planKind: LateFeeKind | null;
  planValue: number | null;
  /** pagamento submetido que a cobre (em validação) */
  pendingPaymentId: string | null;
}
export interface PaymentRow {
  id: string;
  number: number;
  accountId: string | null;
  payerName: string;
  payerEmail: string | null;
  method: PaymentMethod;
  bankAccountId: string | null;
  bankName: string;
  bankIban: string;
  transactionNumber: string;
  paidOn: string;
  total: number;
  note: string | null;
  proofName: string;
  proofMimeType: string;
  proofSize: number;
  proofSha256: string;
  proofStorageKey: string;
  status: PaymentStatus;
  createdByKind: "FAMILY" | "STAFF";
  submittedAt: Date;
  dueAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  items: { chargeId: string; label: string; amount: number; lateFee: number; kind: ChargeKind; studentName: string; applicationId: string | null; enrollmentId: string | null }[];
  /** o mesmo ficheiro noutro pagamento (possível engano ou repetição) */
  sameProof: number;
}
export interface NewPayment {
  id: string;
  accountId: string | null;
  payerName: string;
  method: PaymentMethod;
  bank: { id: string; name: string; iban: string };
  transactionNumber: string;
  paidOn: string;
  note: string | null;
  proof: { name: string; mimeType: string; size: number; sha256: string; storageKey: string };
  createdByKind: "FAMILY" | "STAFF";
  createdById: string;
  dueAt: Date;
  now: Date;
}
export type SubmitOutcome = { ok: true; number: number } | { ok: false; reason: "changed" | "duplicate" };
type Tx = Prisma.TransactionClient;
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2002" || (e.meta as { code?: string } | undefined)?.code === "23505");

const isMissingTable = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && (e.meta as { code?: string } | undefined)?.code === "42P01";

/** A conta pode ver esta cobrança: é de uma inscrição dela, ou de um aluno a que tem acesso. */
const ACCESS = (accountId: string, today: string) => Prisma.sql`(
  EXISTS (SELECT 1 FROM applications ax WHERE ax.id = c.application_id AND ax.account_id = ${accountId}::uuid)
  OR EXISTS (SELECT 1 FROM students sx WHERE sx.id = c.student_id AND sx.account_id = ${accountId}::uuid)
  OR EXISTS (SELECT 1 FROM student_guardians sg JOIN guardians gx ON gx.id = sg.guardian_id JOIN students sx ON sx.id = sg.student_id
              WHERE sg.student_id = c.student_id AND gx.account_id = ${accountId}::uuid AND sg.can_manage AND ${today}::date < (sx.birth_date + interval '18 years')::date))`;

const CHARGE = Prisma.raw(`
  SELECT c.id, c.kind, c.label, c.amount, c.academic_year_id AS "yearId", y.name AS "yearName", c.student_id AS "studentId",
         coalesce(st.full_name, a.student_data->>'fullName', 'Aluno') AS "studentName", st.number AS "studentNumber", c.application_id AS "applicationId", a.number AS "applicationNumber",
         c.enrollment_id AS "enrollmentId", cl.grade, co.name AS "courseName", g.name AS "groupName", c.month, to_char(c.due_on, 'YYYY-MM-DD') AS "dueOn", c.status, c.paid_at AS "paidAt", c.waive_reason AS "waiveReason",
         fp.late_fee_kind AS "planKind", fp.late_fee_value AS "planValue",
         (SELECT p.id FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = c.id AND p.status = 'SUBMITTED' LIMIT 1) AS "pendingPaymentId"
    FROM charges c JOIN academic_years y ON y.id = c.academic_year_id
    LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id LEFT JOIN enrollments e ON e.id = c.enrollment_id
    LEFT JOIN school_classes cl ON cl.id = coalesce(e.class_id, a.class_id) LEFT JOIN courses co ON co.id = cl.course_id LEFT JOIN class_groups g ON g.id = e.group_id
    LEFT JOIN fee_plans fp ON fp.academic_year_id = c.academic_year_id AND c.kind = 'PROPINA'`);
const PAYMENT = Prisma.raw(`
  SELECT p.id, p.number, p.account_id AS "accountId", p.payer_name AS "payerName", fa.email AS "payerEmail", p.method, p.bank_account_id AS "bankAccountId", p.bank_name AS "bankName", p.bank_iban AS "bankIban",
         p.transaction_number AS "transactionNumber", to_char(p.paid_on, 'YYYY-MM-DD') AS "paidOn", p.total, p.note, p.proof_name AS "proofName", p.proof_mime_type AS "proofMimeType", p.proof_size AS "proofSize",
         p.proof_sha256 AS "proofSha256", p.proof_storage_key AS "proofStorageKey", p.status, p.created_by_kind AS "createdByKind", p.submitted_at AS "submittedAt", p.due_at AS "dueAt",
         u.full_name AS "decidedByName", p.decided_at AS "decidedAt", p.decision_note AS "decisionNote",
         (SELECT count(*) FROM payments p2 WHERE p2.proof_sha256 = p.proof_sha256 AND p2.id <> p.id AND p2.status IN ('SUBMITTED', 'VALIDATED'))::int AS "sameProof",
         (SELECT coalesce(json_agg(json_build_object('chargeId', pi.charge_id, 'label', pi.label, 'amount', pi.amount, 'lateFee', pi.late_fee, 'kind', c.kind, 'applicationId', c.application_id, 'enrollmentId', c.enrollment_id,
                   'studentName', coalesce(st.full_name, a.student_data->>'fullName', 'Aluno')) ORDER BY c.due_on NULLS FIRST, pi.label), '[]'::json)
            FROM payment_items pi JOIN charges c ON c.id = pi.charge_id LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id WHERE pi.payment_id = p.id) AS items
    FROM payments p LEFT JOIN family_accounts fa ON fa.id = p.account_id LEFT JOIN school_users u ON u.id = p.decided_by_id`);

/** Pagamentos e cobranças, na BD do colégio. */
export class PrismaPaymentsRepository {
  constructor(private readonly db: PrismaClient) {}

  // ------------------------------------------------------------------ configuração

  async settings(): Promise<SettingsRow> {
    const [r] = await this.db.$queryRaw<SettingsRow[]>`
      SELECT transfer_enabled AS "transferEnabled", active_since AS "activeSince", require_application AS "requireApplication", require_enrollment AS "requireEnrollment", monthly_from AS "monthlyFrom",
             validation_hours AS "validationHours", instructions FROM payment_settings WHERE id = 1`.catch((e: unknown) => {
      // colégio ainda sem a migração 0041: os pagamentos estão desligados e o resto (inscrições…) continua
      if (isMissingTable(e)) return [];
      throw e;
    });
    return r ?? { transferEnabled: false, activeSince: null, requireApplication: true, requireEnrollment: true, monthlyFrom: null, validationHours: 48, instructions: null };
  }

  async saveSettings(s: SettingsRow, actorId: string | null, now: Date) {
    await this.db.$executeRaw`
      INSERT INTO payment_settings (id, transfer_enabled, active_since, require_application, require_enrollment, monthly_from, validation_hours, instructions, updated_by_id, updated_at)
      VALUES (1, ${s.transferEnabled}, ${s.activeSince}::timestamp, ${s.requireApplication}, ${s.requireEnrollment}, ${s.monthlyFrom}, ${s.validationHours}, ${s.instructions}, ${actorId}::uuid, ${now})
      ON CONFLICT (id) DO UPDATE SET transfer_enabled = EXCLUDED.transfer_enabled, active_since = EXCLUDED.active_since, require_application = EXCLUDED.require_application, require_enrollment = EXCLUDED.require_enrollment,
             monthly_from = EXCLUDED.monthly_from, validation_hours = EXCLUDED.validation_hours, instructions = EXCLUDED.instructions, updated_by_id = EXCLUDED.updated_by_id, updated_at = EXCLUDED.updated_at`;
  }

  async accounts(onlyActive = false): Promise<AccountRow[]> {
    return this.db.$queryRaw<AccountRow[]>`
      SELECT b.id, b.bank_name AS "bankName", b.holder, b.account_number AS "accountNumber", b.iban, b.notes, b.active, b.position, EXISTS (SELECT 1 FROM payments p WHERE p.bank_account_id = b.id) AS used
        FROM bank_accounts b WHERE (NOT ${onlyActive} OR b.active) ORDER BY b.position, b.bank_name, b.created_at`;
  }

  /** false = já existe outra conta com este IBAN. */
  async saveAccount(a: { id: string; bankName: string; holder: string; accountNumber: string | null; iban: string; notes: string | null; active: boolean }, now: Date) {
    try {
      await this.db.$executeRaw`
        INSERT INTO bank_accounts (id, bank_name, holder, account_number, iban, notes, active, position, created_at, updated_at)
        VALUES (${a.id}::uuid, ${a.bankName}, ${a.holder}, ${a.accountNumber}, ${a.iban}, ${a.notes}, ${a.active}, (SELECT coalesce(max(position), 0) + 1 FROM bank_accounts), ${now}, ${now})
        ON CONFLICT (id) DO UPDATE SET bank_name = EXCLUDED.bank_name, holder = EXCLUDED.holder, account_number = EXCLUDED.account_number, iban = EXCLUDED.iban, notes = EXCLUDED.notes, active = EXCLUDED.active, updated_at = EXCLUDED.updated_at`;
      return true;
    } catch (e) {
      if (isUnique(e)) return false;
      throw e;
    }
  }

  /** Só se nunca recebeu um pagamento. */
  async removeAccount(id: string) {
    return (await this.db.$executeRaw`DELETE FROM bank_accounts b WHERE b.id = ${id}::uuid AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.bank_account_id = b.id)`) === 1;
  }

  // ------------------------------------------------------------------ cobranças

  /**
   * Põe as cobranças de acordo com o preçário (idempotente; pode correr as vezes que for preciso):
   * cria as que faltam, atualiza o valor das que estão por pagar (e não em validação) e deixa sem efeito
   * as que já não se aplicam. Só a partir de quando o colégio ativou os pagamentos.
   * Âmbito: uma inscrição, um aluno, ou tudo (o ciclo automático).
   */
  async sync(s: SettingsRow, now: Date, only: { applicationId?: string; accountId?: string } = {}) {
    if (!s.transferEnabled || !s.activeSince) return;
    const since = s.activeSince;
    const app = only.applicationId ? Prisma.sql`AND a.id = ${only.applicationId}::uuid` : only.accountId ? Prisma.sql`AND a.account_id = ${only.accountId}::uuid` : Prisma.empty;
    const enr = only.accountId
        ? Prisma.sql`AND e.student_id IN (SELECT id FROM students WHERE account_id = ${only.accountId}::uuid UNION SELECT sg.student_id FROM student_guardians sg JOIN guardians gu ON gu.id = sg.guardian_id WHERE gu.account_id = ${only.accountId}::uuid)`
        : Prisma.empty;
    /** por pagar e fora de um pagamento em validação: pode mudar */
    const free = Prisma.sql`NOT EXISTS (SELECT 1 FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = charges.id AND p.status IN ('SUBMITTED', 'VALIDATED'))`;
    const pupil = Prisma.sql`(f.applies_to = 'TODOS' OR f.applies_to = CASE WHEN a.process_type = 'RENOVACAO' THEN 'CONTINUANTES' ELSE 'NOVOS' END)`;
    const wanted = Prisma.sql`
      SELECT a.id AS application_id, a.student_id, a.academic_year_id, f.id AS fee_item_id, CASE WHEN f.charged_at = 'INSCRICAO' THEN 'INSCRICAO' ELSE 'MATRICULA' END AS kind,
             f.name || CASE WHEN f.billing = 'MENSAL' THEN ' · 1.ª mensalidade' ELSE '' END AS label, cf.amount
        FROM applications a JOIN class_fees cf ON cf.class_id = a.class_id AND cf.amount > 0 JOIN fee_items f ON f.id = cf.fee_item_id AND f.archived_at IS NULL AND f.charged_at IN ('INSCRICAO', 'MATRICULA')
       WHERE ${pupil}
         AND ((f.charged_at = 'INSCRICAO' AND a.status IN ('SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED') AND a.submitted_at >= ${since})
           OR (f.charged_at = 'MATRICULA' AND a.status = 'APPROVED' AND (SELECT max(h.created_at) FROM application_history h WHERE h.application_id = a.id AND h.to_status = 'APPROVED') >= ${since}))
         ${app}`;
    const monthly = Prisma.sql`
      SELECT e.id AS enrollment_id, e.student_id, e.academic_year_id, f.id AS fee_item_id, m.month, cf.amount,
             f.name || ' · ' || (ARRAY['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'])[split_part(m.month, '-', 2)::int] || ' ' || split_part(m.month, '-', 1) AS label,
             (m.month || '-' || lpad(fp.due_day::text, 2, '0'))::date AS due_on
        FROM enrollments e JOIN academic_years y ON y.id = e.academic_year_id AND y.status <> 'CLOSED' LEFT JOIN applications a ON a.id = e.application_id
        JOIN class_fees cf ON cf.class_id = e.class_id AND cf.amount > 0 JOIN fee_items f ON f.id = cf.fee_item_id AND f.archived_at IS NULL AND f.billing = 'MENSAL'
        JOIN fee_plans fp ON fp.academic_year_id = e.academic_year_id CROSS JOIN LATERAL jsonb_array_elements_text(fp.months) AS m(month)
       WHERE e.status = 'ACTIVE' AND ${s.monthlyFrom}::text IS NOT NULL AND m.month >= ${s.monthlyFrom} AND m.month >= to_char(e.enrolled_at, 'YYYY-MM') AND ${pupil}
         -- a 1.ª mensalidade já se cobrou na inscrição ou na matrícula
         AND (f.charged_at = 'DURANTE' OR m.month > (SELECT min(m2.month) FROM jsonb_array_elements_text(fp.months) AS m2(month) WHERE m2.month >= to_char(e.enrolled_at, 'YYYY-MM')))
         ${enr}`;
    const work: Prisma.PrismaPromise<number>[] = [
      // sem efeito: a inscrição foi recusada, mudou de classe ou a rubrica deixou de se cobrar
      this.db.$executeRaw`
        UPDATE charges SET status = 'VOID', updated_at = ${now} FROM applications a
         WHERE charges.application_id = a.id ${app} AND charges.kind IN ('INSCRICAO', 'MATRICULA') AND charges.status = 'OPEN' AND ${free}
           AND NOT EXISTS (SELECT 1 FROM (${wanted}) w WHERE w.application_id = charges.application_id AND w.fee_item_id = charges.fee_item_id AND w.kind = charges.kind)`,
      this.db.$executeRaw`
        INSERT INTO charges (id, kind, label, amount, academic_year_id, student_id, application_id, fee_item_id, status, created_at, updated_at)
        SELECT gen_random_uuid(), w.kind, w.label, w.amount, w.academic_year_id, w.student_id, w.application_id, w.fee_item_id, 'OPEN', ${now}, ${now} FROM (${wanted}) w
        ON CONFLICT (application_id, fee_item_id, kind) WHERE application_id IS NOT NULL AND kind IN ('INSCRICAO', 'MATRICULA')
        DO UPDATE SET amount = EXCLUDED.amount, label = EXCLUDED.label, student_id = EXCLUDED.student_id, academic_year_id = EXCLUDED.academic_year_id, status = 'OPEN', updated_at = EXCLUDED.updated_at
         WHERE charges.status IN ('OPEN', 'VOID') AND ${free} AND (charges.status = 'VOID' OR charges.amount <> EXCLUDED.amount OR charges.label <> EXCLUDED.label OR charges.student_id IS DISTINCT FROM EXCLUDED.student_id)`,
    ];
    // numa inscrição só interessam as cobranças dela (o resto faz-se uma vez por dia e na área da família)
    if (!only.applicationId)
      work.push(
        // propinas: um mês de cada vez, do calendário do ano
        this.db.$executeRaw`
          INSERT INTO charges (id, kind, label, amount, academic_year_id, student_id, enrollment_id, fee_item_id, month, due_on, status, created_at, updated_at)
          SELECT gen_random_uuid(), 'PROPINA', w.label, w.amount, w.academic_year_id, w.student_id, w.enrollment_id, w.fee_item_id, w.month, w.due_on, 'OPEN', ${now}, ${now} FROM (${monthly}) w
          ON CONFLICT (enrollment_id, fee_item_id, coalesce(month, '')) WHERE enrollment_id IS NOT NULL AND kind IN ('PROPINA', 'OUTRA')
          DO UPDATE SET amount = EXCLUDED.amount, label = EXCLUDED.label, due_on = EXCLUDED.due_on, status = 'OPEN', updated_at = EXCLUDED.updated_at
           WHERE charges.status IN ('OPEN', 'VOID') AND ${free} AND (charges.status = 'VOID' OR charges.amount <> EXCLUDED.amount OR charges.due_on <> EXCLUDED.due_on)`,
        this.db.$executeRaw`
          UPDATE charges SET status = 'VOID', updated_at = ${now} FROM enrollments e
           WHERE charges.enrollment_id = e.id ${enr} AND charges.kind = 'PROPINA' AND charges.status = 'OPEN' AND ${free}
             AND (CASE WHEN e.status <> 'ACTIVE' THEN charges.month > to_char(e.updated_at, 'YYYY-MM') ELSE NOT EXISTS (SELECT 1 FROM (${monthly}) w WHERE w.enrollment_id = charges.enrollment_id AND w.fee_item_id = charges.fee_item_id AND w.month = charges.month) END)`,
        // rubricas únicas "durante o ano"
        this.db.$executeRaw`
          INSERT INTO charges (id, kind, label, amount, academic_year_id, student_id, enrollment_id, fee_item_id, status, created_at, updated_at)
          SELECT gen_random_uuid(), 'OUTRA', f.name, cf.amount, e.academic_year_id, e.student_id, e.id, f.id, 'OPEN', ${now}, ${now}
            FROM enrollments e JOIN academic_years y ON y.id = e.academic_year_id AND y.status <> 'CLOSED' LEFT JOIN applications a ON a.id = e.application_id
            JOIN class_fees cf ON cf.class_id = e.class_id AND cf.amount > 0 JOIN fee_items f ON f.id = cf.fee_item_id AND f.archived_at IS NULL AND f.billing = 'UNICA' AND f.charged_at = 'DURANTE'
           WHERE e.status = 'ACTIVE' AND e.enrolled_at >= ${since} AND ${pupil} ${enr}
          ON CONFLICT (enrollment_id, fee_item_id, coalesce(month, '')) WHERE enrollment_id IS NOT NULL AND kind IN ('PROPINA', 'OUTRA')
          DO UPDATE SET amount = EXCLUDED.amount, label = EXCLUDED.label, updated_at = EXCLUDED.updated_at WHERE charges.status = 'OPEN' AND ${free} AND charges.amount <> EXCLUDED.amount`,
      );
    await this.db.$transaction(work);
  }

  familyCharges(accountId: string, today: string): Promise<ChargeRow[]> {
    return this.db.$queryRaw<ChargeRow[]>`${CHARGE} WHERE c.status <> 'VOID' AND ${ACCESS(accountId, today)} ORDER BY c.due_on NULLS FIRST, c.created_at, c.label`;
  }

  applicationCharges(applicationId: string): Promise<ChargeRow[]> {
    return this.db.$queryRaw<ChargeRow[]>`${CHARGE} WHERE c.status <> 'VOID' AND c.application_id = ${applicationId}::uuid ORDER BY c.kind, c.label`;
  }

  async chargesByIds(ids: string[], access?: { accountId: string; today: string }): Promise<ChargeRow[]> {
    return this.db.$queryRaw<ChargeRow[]>`${CHARGE} WHERE c.id = ANY(${ids}::uuid[]) ${access ? Prisma.sql`AND ${ACCESS(access.accountId, access.today)}` : Prisma.empty}`;
  }

  async listCharges(f: { status?: string; kind?: string; q?: string; yearId?: string; page: number; pageSize: number; today: string }) {
    /** fora de um pagamento em validação */
    const idle = Prisma.sql`NOT EXISTS (SELECT 1 FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = c.id AND p.status = 'SUBMITTED')`;
    const where = Prisma.sql`
      ${
        f.status === "VALIDATION"
          ? Prisma.sql`c.status = 'OPEN' AND EXISTS (SELECT 1 FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = c.id AND p.status = 'SUBMITTED')`
          : f.status === "OVERDUE"
            ? Prisma.sql`c.status = 'OPEN' AND c.due_on < ${f.today}::date AND ${idle}`
            : f.status === "OPEN"
              ? Prisma.sql`c.status = 'OPEN' AND ${idle}`
            : f.status
              ? Prisma.sql`c.status = ${f.status}`
              : Prisma.sql`c.status <> 'VOID'`
      }
      ${f.kind ? Prisma.sql`AND c.kind = ${f.kind}` : Prisma.empty} ${f.yearId ? Prisma.sql`AND c.academic_year_id = ${f.yearId}::uuid` : Prisma.empty}
      ${f.q ? Prisma.sql`AND (coalesce(st.full_name, a.student_data->>'fullName', '') ILIKE ${`%${f.q}%`} OR a.number ILIKE ${`%${f.q}%`} OR lpad(st.number::text, 5, '0') = ${f.q})` : Prisma.empty}`;
    const [items, [sum]] = await Promise.all([
      this.db.$queryRaw<ChargeRow[]>`${CHARGE} WHERE ${where} ORDER BY c.due_on NULLS LAST, "studentName", c.label LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
      this.db.$queryRaw<{ n: number; total: number }[]>`SELECT count(*)::int AS n, coalesce(sum(c.amount), 0)::float8 AS total FROM charges c LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id WHERE ${where}`,
    ]);
    return { items, total: sum.n, amount: sum.total };
  }

  async waive(id: string, reason: string, actorId: string, now: Date) {
    return (
      (await this.db.$executeRaw`
        UPDATE charges SET status = 'WAIVED', waive_reason = ${reason}, decided_by_id = ${actorId}::uuid, decided_at = ${now}, updated_at = ${now}
         WHERE id = ${id}::uuid AND status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = charges.id AND p.status = 'SUBMITTED')`) === 1
    );
  }

  async reopen(id: string, actorId: string, now: Date) {
    return (await this.db.$executeRaw`UPDATE charges SET status = 'OPEN', waive_reason = NULL, decided_by_id = ${actorId}::uuid, decided_at = ${now}, updated_at = ${now} WHERE id = ${id}::uuid AND status = 'WAIVED'`) === 1;
  }

  // ------------------------------------------------------------------ pagamentos

  /** Grava o pagamento e as cobranças que cobre, se continuarem por pagar (bloqueadas enquanto se grava). */
  async submit(p: NewPayment, items: { chargeId: string; label: string; amount: number; lateFee: number }[]): Promise<SubmitOutcome> {
    try {
      return await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string; amount: number; status: string }[]>`SELECT id, amount, status FROM charges WHERE id = ANY(${items.map((i) => i.chargeId)}::uuid[]) ORDER BY id FOR UPDATE`;
        // já com as cobranças bloqueadas, numa consulta nova: assim vê um pagamento que outro pedido acabou de gravar
        const [busy] = await tx.$queryRaw<{ id: string }[]>`SELECT x.id FROM payment_items pi JOIN payments x ON x.id = pi.payment_id WHERE pi.charge_id = ANY(${items.map((i) => i.chargeId)}::uuid[]) AND x.status = 'SUBMITTED' LIMIT 1`;
        if (busy || locked.length !== items.length || locked.some((l) => l.status !== "OPEN" || l.amount !== items.find((i) => i.chargeId === l.id)!.amount)) return { ok: false, reason: "changed" } as const;
        const total = items.reduce((n, i) => n + i.amount + i.lateFee, 0);
        const [row] = await tx.$queryRaw<{ number: number }[]>`
          INSERT INTO payments (id, account_id, payer_name, method, bank_account_id, bank_name, bank_iban, transaction_number, paid_on, total, note, proof_name, proof_mime_type, proof_size, proof_sha256, proof_storage_key,
                                status, created_by_kind, created_by_id, submitted_at, due_at)
          VALUES (${p.id}::uuid, ${p.accountId}::uuid, ${p.payerName}, ${p.method}, ${p.bank.id}::uuid, ${p.bank.name}, ${p.bank.iban}, ${p.transactionNumber}, ${p.paidOn}::date, ${total}, ${p.note}, ${p.proof.name}, ${p.proof.mimeType},
                  ${p.proof.size}, ${p.proof.sha256}, ${p.proof.storageKey}, 'SUBMITTED', ${p.createdByKind}, ${p.createdById}::uuid, ${p.now}, ${p.dueAt}) RETURNING number`;
        await tx.$executeRaw`
          INSERT INTO payment_items (payment_id, charge_id, label, amount, late_fee)
          SELECT ${p.id}::uuid, x."chargeId", x.label, x.amount, x."lateFee" FROM json_to_recordset(${JSON.stringify(items)}::json) AS x("chargeId" uuid, label text, amount int, "lateFee" int)`;
        await this.recordIn(tx, "PAYMENT_SUBMITTED", p.id, p.createdByKind === "STAFF" ? p.createdById : null, { total, method: p.method, transaction: p.transactionNumber, bank: p.bank.name, items: items.map((i) => i.label) }, p.now);
        return { ok: true, number: row.number } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { ok: false, reason: "duplicate" };
      throw e;
    }
  }

  /**
   * Muda o estado do pagamento (só se ainda estiver num dos estados de partida) e o das cobranças que cobre,
   * e deixa o aviso na área da família, tudo na mesma transação. false = já mudou entretanto.
   */
  async decide(id: string, from: PaymentStatus[], to: PaymentStatus, d: { actorId: string | null; note: string | null; now: Date; record: string; family: { title: string; body: string } | null }) {
    return this.db.$transaction(async (tx) => {
      // as cobranças primeiro, para duas decisões ao mesmo tempo não se cruzarem
      await tx.$queryRaw`SELECT c.id FROM charges c JOIN payment_items pi ON pi.charge_id = c.id WHERE pi.payment_id = ${id}::uuid ORDER BY c.id FOR UPDATE OF c`;
      const [before] = await tx.$queryRaw<{ status: string; account_id: string | null }[]>`SELECT status, account_id FROM payments WHERE id = ${id}::uuid FOR UPDATE`;
      if (!before || !(from as string[]).includes(before.status)) return false;
      if (to === "VALIDATED") {
        // outra pessoa pode ter isentado uma das cobranças: então não se valida
        const [bad] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_items pi JOIN charges c ON c.id = pi.charge_id WHERE pi.payment_id = ${id}::uuid AND c.status <> 'OPEN'`;
        if (bad.n) return false;
        await tx.$executeRaw`UPDATE charges SET status = 'PAID', paid_at = ${d.now}, updated_at = ${d.now} FROM payment_items pi WHERE pi.payment_id = ${id}::uuid AND charges.id = pi.charge_id`;
      } else if (before.status === "VALIDATED")
        await tx.$executeRaw`UPDATE charges SET status = 'OPEN', paid_at = NULL, updated_at = ${d.now} FROM payment_items pi WHERE pi.payment_id = ${id}::uuid AND charges.id = pi.charge_id AND charges.status = 'PAID'`;
      await tx.$executeRaw`UPDATE payments SET status = ${to}, decided_by_id = ${d.actorId}::uuid, decided_at = ${d.now}, decision_note = ${d.note} WHERE id = ${id}::uuid`;
      await this.recordIn(tx, d.record, id, d.actorId, { from: before.status, to, reason: d.note }, d.now);
      if (d.family && before.account_id) await notifyFamily(tx, { accountId: before.account_id, kind: "PAYMENT", title: d.family.title, body: d.family.body, link: `/familia/pagamentos?pagamento=${id}`, now: d.now });
      return true;
    });
  }

  async payment(id: string, accountId?: string): Promise<PaymentRow | null> {
    const r = await this.db.$queryRaw<PaymentRow[]>`${PAYMENT} WHERE p.id = ${id}::uuid ${accountId ? Prisma.sql`AND p.account_id = ${accountId}::uuid` : Prisma.empty}`;
    return r[0] ?? null;
  }

  familyPayments(accountId: string): Promise<PaymentRow[]> {
    return this.db.$queryRaw<PaymentRow[]>`${PAYMENT} WHERE p.account_id = ${accountId}::uuid ORDER BY p.submitted_at DESC LIMIT 100`;
  }

  async listPayments(f: { status?: PaymentStatus; q?: string; overdue?: Date; page: number; pageSize: number }) {
    const where = Prisma.sql`true ${f.status ? Prisma.sql`AND p.status = ${f.status}` : Prisma.empty} ${f.overdue ? Prisma.sql`AND p.status = 'SUBMITTED' AND p.due_at < ${f.overdue}` : Prisma.empty}
      ${f.q ? Prisma.sql`AND (p.payer_name ILIKE ${`%${f.q}%`} OR p.transaction_number ILIKE ${`%${f.q}%`} OR ('PAG-' || lpad(p.number::text, 6, '0')) ILIKE ${`%${f.q}%`}
        OR EXISTS (SELECT 1 FROM payment_items pi JOIN charges c ON c.id = pi.charge_id LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id
                    WHERE pi.payment_id = p.id AND (coalesce(st.full_name, a.student_data->>'fullName', '') ILIKE ${`%${f.q}%`} OR a.number ILIKE ${`%${f.q}%`})))` : Prisma.empty}`;
    const [items, [count]] = await Promise.all([
      // por validar: o mais antigo primeiro; os outros, o mais recente
      this.db.$queryRaw<PaymentRow[]>`${PAYMENT} WHERE ${where} ORDER BY ${f.status === "SUBMITTED" ? Prisma.sql`p.submitted_at ASC` : Prisma.sql`p.submitted_at DESC`} LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
      this.db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM payments p WHERE ${where}`,
    ]);
    return { items, total: count.n };
  }

  async paymentCounts(now: Date) {
    const r = await this.db.$queryRaw<{ status: PaymentStatus; n: number; total: number; overdue: number }[]>`
      SELECT status, count(*)::int AS n, coalesce(sum(total), 0)::float8 AS total, count(*) FILTER (WHERE status = 'SUBMITTED' AND due_at < ${now})::int AS overdue FROM payments GROUP BY status`;
    return r;
  }

  async history(id: string) {
    return this.db.$queryRaw<{ at: Date; type: string; by: string | null; details: Record<string, unknown> | null }[]>`
      SELECT a.occurred_at AS at, a.type, u.full_name AS by, a.details FROM school_activity a LEFT JOIN school_users u ON u.id = a.actor_id WHERE a.subject_id = ${id}::uuid ORDER BY a.occurred_at`;
  }

  // ------------------------------------------------------------------ avisos

  /** Quem tem uma destas permissões (e o responsável): as pessoas ativas. */
  async staffWith(permissions: string[]): Promise<string[]> {
    const r = await this.db.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM school_users u WHERE u.status = 'ACTIVE' AND (u.is_owner OR EXISTS (SELECT 1 FROM school_user_permissions p WHERE p.user_id = u.id AND p.permission = ANY(${permissions})))`;
    return r.map((x) => x.id);
  }

  /** Pagamentos por validar fora do prazo, ainda sem aviso (reserva-os: só se avisa uma vez). */
  async claimOverdue(now: Date) {
    return this.db.$queryRaw<{ id: string; number: number; total: number; payer_name: string }[]>`
      UPDATE payments SET overdue_notified_at = ${now} WHERE status = 'SUBMITTED' AND due_at < ${now} AND overdue_notified_at IS NULL RETURNING id, number, total, payer_name`;
  }

  /** Aviso avulso na área da família (ex.: valores da matrícula por pagar). */
  async tellFamily(accountId: string, title: string, body: string, studentId: string | null, now: Date) {
    await notifyFamily(this.db, { accountId, kind: "PAYMENT", title, body, link: "/familia/pagamentos", studentId, now });
  }

  async familyType() {
    const [r] = await this.db.$queryRaw<{ enabled: boolean; email: boolean }[]>`SELECT enabled, email FROM notification_types WHERE kind = 'PAYMENT'`;
    return r ?? null;
  }
  async familyWantsEmail(accountId: string) {
    const [r] = await this.db.$queryRaw<{ email: boolean }[]>`SELECT email FROM family_notification_preferences WHERE account_id = ${accountId}::uuid AND kind = 'PAYMENT'`;
    return r?.email ?? true;
  }
  async logFamilyEmail(e: { accountId: string; fullName: string; title: string; destination: string | null; status: "SENT" | "FAILED" | "SKIPPED"; error: string | null; now: Date }) {
    await this.db.$executeRaw`
      INSERT INTO notification_deliveries (id, audience, notification_id, recipient_id, recipient_name, kind, title, channel, destination, status, error, created_at)
      VALUES (${randomUUID()}::uuid, 'FAMILY', NULL, ${e.accountId}::uuid, ${e.fullName}, 'PAYMENT', ${e.title.slice(0, 200)}, 'EMAIL', ${e.destination}, ${e.status}, ${e.error}, ${e.now})`;
  }

  async application(id: string) {
    const [r] = await this.db.$queryRaw<{ account_id: string; student_id: string | null; student: string }[]>`
      SELECT a.account_id, a.student_id, coalesce(st.full_name, a.student_data->>'fullName', 'o aluno') AS student FROM applications a LEFT JOIN students st ON st.id = a.student_id WHERE a.id = ${id}::uuid`;
    return r ?? null;
  }

  async record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await this.recordIn(this.db, type, subjectId, actorId, details, now);
  }
  private async recordIn(db: PrismaClient | Tx, type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date) {
    await db.schoolActivity.create({ data: { id: randomUUID(), type, subjectId, actorId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}
