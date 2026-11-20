import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from ".prisma/tenant-client";

export type NotificationKind = "APPLICATION_CORRECTION" | "APPLICATION_APPROVED" | "APPLICATION_REJECTED" | "ENROLLED" | "HANDOVER_INVITED" | "HANDOVER_DONE" | "HANDOVER_WELCOME";

/**
 * Grava um aviso na área da família (dentro da mesma transação de quem o causa: a decisão, a
 * matrícula…). O que se mostra fica escrito aqui; a família lê-o em "Notificações".
 */
export async function notifyFamily(
  db: PrismaClient | Prisma.TransactionClient,
  n: { accountId: string; kind: NotificationKind | (string & {}); title: string; body?: string | null; link?: string | null; studentId?: string | null; now: Date },
) {
  await db.$executeRaw`
    INSERT INTO family_notifications (id, account_id, kind, title, body, link, student_id, created_at)
    VALUES (${randomUUID()}::uuid, ${n.accountId}::uuid, ${n.kind}, ${n.title.slice(0, 200)}, ${n.body?.slice(0, 1000) ?? null}, ${n.link ?? null}, ${n.studentId ?? null}::uuid, ${n.now})`;
}
