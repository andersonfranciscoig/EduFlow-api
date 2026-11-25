import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from ".prisma/tenant-client";
import type { LateFeeKind } from "../domain/pricing";

export type ReminderStage = "BEFORE" | "DUE" | "AFTER" | "MANUAL";
export interface DueReminder {
  chargeId: string;
  label: string;
  amount: number;
  dueOn: string | null;
  studentName: string;
  studentId: string | null;
  planKind: LateFeeKind | null;
  planValue: number | null;
  accountId: string;
  email: string;
  fullName: string;
  stage: ReminderStage;
}
export interface ReminderRules {
  beforeDays: number;
  onDue: boolean;
  everyDays: number;
  max: number;
}

/** A quem se lembra uma cobrança: o aluno maior com conta, o encarregado que gere o menor, ou quem fez a inscrição. */
const RECIPIENTS = Prisma.raw(`
  SELECT c.id AS charge_id, fa.id AS account_id, fa.email, fa.full_name
    FROM charges c JOIN students s ON s.id = c.student_id JOIN family_accounts fa ON fa.id = s.account_id
  UNION
  SELECT c.id, fa.id, fa.email, fa.full_name
    FROM charges c JOIN students s ON s.id = c.student_id JOIN student_guardians sg ON sg.student_id = s.id AND sg.can_manage JOIN guardians g ON g.id = sg.guardian_id JOIN family_accounts fa ON fa.id = g.account_id
   WHERE (now() AT TIME ZONE 'Africa/Luanda')::date < (s.birth_date + interval '18 years')::date
  UNION
  SELECT c.id, fa.id, fa.email, fa.full_name
    FROM charges c JOIN applications a ON a.id = c.application_id JOIN family_accounts fa ON fa.id = a.account_id WHERE c.student_id IS NULL`);
const COLUMNS = Prisma.raw(`
  c.id AS "chargeId", c.label, c.amount, to_char(c.due_on, 'YYYY-MM-DD') AS "dueOn", coalesce(st.full_name, a.student_data->>'fullName', 'Aluno') AS "studentName", c.student_id AS "studentId",
  fp.late_fee_kind AS "planKind", fp.late_fee_value AS "planValue", r.account_id AS "accountId", r.email, r.full_name AS "fullName"`);
const JOINS = Prisma.raw(`
  JOIN recipients r ON r.charge_id = c.id LEFT JOIN students st ON st.id = c.student_id LEFT JOIN applications a ON a.id = c.application_id
  LEFT JOIN fee_plans fp ON fp.academic_year_id = c.academic_year_id AND c.kind = 'PROPINA'`);
/** por pagar e fora de um pagamento em validação */
const OPEN = Prisma.raw(`c.status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM payment_items pi JOIN payments p ON p.id = pi.payment_id WHERE pi.charge_id = c.id AND p.status = 'SUBMITTED')`);

export class PrismaRemindersRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Os lembretes de propinas que faltam enviar hoje: antes do prazo (uma vez), no próprio dia, e em atraso de N em N
   * dias até ao máximo. Um dia falhado recupera-se no seguinte (conta-se pelo que já foi enviado a cada conta).
   */
  due(today: string, r: ReminderRules): Promise<DueReminder[]> {
    return this.db.$queryRaw<DueReminder[]>`
      WITH recipients AS (${RECIPIENTS}), due AS (
        SELECT ${COLUMNS}, c.due_on,
               (SELECT max(x.day) FROM charge_reminders x WHERE x.charge_id = c.id AND x.account_id = r.account_id) AS last_day,
               (SELECT max(x.day) FROM charge_reminders x WHERE x.charge_id = c.id AND x.account_id = r.account_id AND x.stage IN ('AFTER', 'MANUAL')) AS last_after,
               (SELECT count(*) FROM charge_reminders x WHERE x.charge_id = c.id AND x.account_id = r.account_id AND x.stage = 'AFTER') AS after_count,
               EXISTS (SELECT 1 FROM charge_reminders x WHERE x.charge_id = c.id AND x.account_id = r.account_id AND x.stage = 'BEFORE') AS before_sent
          FROM charges c ${JOINS}
         WHERE c.kind = 'PROPINA' AND c.due_on IS NOT NULL AND c.due_on <= ${today}::date + ${r.beforeDays}::int AND ${OPEN})
      SELECT d.*, CASE WHEN d.due_on > ${today}::date THEN 'BEFORE' WHEN d.due_on = ${today}::date THEN 'DUE' ELSE 'AFTER' END AS stage
        FROM due d
       WHERE d.last_day IS DISTINCT FROM ${today}::date
         AND CASE WHEN d.due_on > ${today}::date THEN ${r.beforeDays}::int > 0 AND NOT d.before_sent
                  WHEN d.due_on = ${today}::date THEN ${r.onDue}::boolean
                  ELSE ${r.max}::int > 0 AND d.after_count < ${r.max}::int AND ${today}::date - coalesce(d.last_after, d.due_on) >= ${r.everyDays}::int END
       ORDER BY d."accountId", d."dueOn"`;
  }

  /** As cobranças escolhidas (ou todas as propinas em atraso) que se podem lembrar agora: hoje ainda não receberam lembrete. */
  manual(today: string, chargeIds: string[] | null): Promise<DueReminder[]> {
    return this.db.$queryRaw<DueReminder[]>`
      WITH recipients AS (${RECIPIENTS})
      SELECT ${COLUMNS}, 'MANUAL' AS stage FROM charges c ${JOINS}
       WHERE ${OPEN} AND ${chargeIds ? Prisma.sql`c.id = ANY(${chargeIds}::uuid[])` : Prisma.sql`c.kind = 'PROPINA' AND c.due_on < ${today}::date`}
         AND NOT EXISTS (SELECT 1 FROM charge_reminders x WHERE x.charge_id = c.id AND x.account_id = r.account_id AND x.day = ${today}::date)
       ORDER BY "accountId", "dueOn" NULLS LAST LIMIT 5000`;
  }

  /** Reserva os lembretes (o que outro processo já reservou não volta). */
  async claim(list: DueReminder[], today: string, byId: string | null, now: Date): Promise<DueReminder[]> {
    if (!list.length) return [];
    const rows = list.map((x) => ({ id: randomUUID(), c: x.chargeId, a: x.accountId, s: x.stage }));
    const got = await this.db.$queryRaw<{ charge_id: string; account_id: string }[]>`
      INSERT INTO charge_reminders (id, charge_id, account_id, stage, day, sent_at, by_id)
      SELECT x.id, x.c, x.a, x.s, ${today}::date, ${now}, ${byId}::uuid FROM json_to_recordset(${JSON.stringify(rows)}::json) AS x(id uuid, c uuid, a uuid, s text)
      ON CONFLICT (charge_id, account_id, day) DO NOTHING RETURNING charge_id, account_id`;
    const key = new Set(got.map((g) => `${g.charge_id}:${g.account_id}`));
    return list.filter((x) => key.has(`${x.chargeId}:${x.accountId}`));
  }
}
