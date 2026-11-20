import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";

export type NotificationKind = "APPLICATION_CORRECTION" | "APPLICATION_APPROVED" | "APPLICATION_REJECTED" | "ENROLLED" | "HANDOVER_INVITED" | "HANDOVER_DONE" | "HANDOVER_WELCOME";

/**
 * Grava um aviso na área da família (dentro da mesma transação de quem o causa: a decisão, a
 * matrícula…). O que se mostra fica escrito aqui; a família lê-o em "Notificações".
 * Respeita os tipos do colégio (um tipo desligado não chega) e deixa o envio no histórico.
 */
export async function notifyFamily(
  db: PrismaClient | Prisma.TransactionClient,
  n: { accountId: string; kind: NotificationKind | (string & {}); title: string; body?: string | null; link?: string | null; studentId?: string | null; now: Date },
) {
  const title = n.title.slice(0, 200);
  await db.$executeRaw`
    WITH t AS (SELECT coalesce((SELECT enabled FROM notification_types WHERE kind = ${n.kind}), true) AS on_),
    ins AS (
      INSERT INTO family_notifications (id, account_id, kind, title, body, link, student_id, created_at)
      SELECT ${randomUUID()}::uuid, ${n.accountId}::uuid, ${n.kind}, ${title}, ${n.body?.slice(0, 1000) ?? null}, ${n.link ?? null}, ${n.studentId ?? null}::uuid, ${n.now} FROM t WHERE t.on_
      RETURNING id
    )
    INSERT INTO notification_deliveries (id, audience, notification_id, recipient_id, recipient_name, kind, title, channel, status, error, created_at)
    SELECT ${randomUUID()}::uuid, 'FAMILY', (SELECT id FROM ins), ${n.accountId}::uuid, (SELECT full_name FROM family_accounts WHERE id = ${n.accountId}::uuid), ${n.kind}, ${title}, 'IN_APP',
           CASE WHEN t.on_ THEN 'SENT' ELSE 'SKIPPED' END, CASE WHEN t.on_ THEN NULL ELSE 'Tipo desligado pelo colégio' END, ${n.now}
      FROM t`;
}
