import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { PrismaClient } from ".prisma/tenant-client";
import { escapeHtml, type Mailer } from "../../../../../../libs/kernel/src/infrastructure/mail";
import { KINDS, type Kind } from "../domain/catalog";

/** Aviso para a equipa: a quem (utilizadores ou funcionários com conta), o quê e para onde leva. */
export interface StaffNotice {
  kind: Kind;
  userIds?: string[];
  /** funcionários (ex.: o professor da aula): chega à conta do portal ligada, se houver */
  employeeIds?: string[];
  title: string;
  body?: string | null;
  link?: string | null;
  /** o mesmo aviso (mesma chave) não chega duas vezes à mesma pessoa */
  dedupeKey?: string | null;
}

/** Porta que os serviços usam (já ligada ao colégio do pedido). */
export interface StaffNotify {
  notify(n: StaffNotice): Promise<{ delivered: number }>;
}

const frame = (school: string, title: string, body: string, url: string | null) => `<!doctype html><html lang="pt"><body style="margin:0;background:#DAF1DE;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#051F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;overflow:hidden">
<tr><td style="background:#0B2B26;padding:22px 28px;color:#DAF1DE;font-size:15px;font-weight:600">EduFlow <span style="color:#8EB69B;font-weight:400">· ${escapeHtml(school)}</span></td></tr>
<tr><td style="padding:28px 28px 8px"><p style="margin:0 0 10px;font-size:18px;font-weight:600">${escapeHtml(title)}</p><p style="margin:0;font-size:14px;line-height:1.6;color:#235347">${escapeHtml(body)}</p></td></tr>
<tr><td style="padding:20px 28px 30px">${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;background:#163832;color:#DAF1DE;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:999px">Abrir no portal</a>` : ""}
<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#8EB69B">Pode deixar de receber estes emails em Notificações → Preferências.</p></td></tr>
</table></td></tr></table></body></html>`;

/**
 * Entrega os avisos da equipa: na plataforma (sempre que o tipo está ligado) e por email (se o
 * colégio o enviar por email e a pessoa não o recusou). Cada tentativa fica no histórico de envios.
 */
export class Notifier {
  private readonly logger = new Logger("Notifier");

  constructor(
    private readonly mailer: Mailer,
    private readonly portalUrlTemplate: string,
  ) {}

  /** O notificador ligado a um colégio (BD + endereço do portal). */
  for(db: PrismaClient, tenant: { slug: string; name?: string }, clock: () => Date = () => new Date()): StaffNotify {
    return { notify: (n) => this.staff(db, tenant, n, clock()) };
  }

  async staff(db: PrismaClient, tenant: { slug: string; name?: string }, n: StaffNotice, now: Date) {
    const info = KINDS[n.kind];
    const userIds = new Set(n.userIds ?? []);
    if (n.employeeIds?.length) {
      const rows = await db.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM employees WHERE id = ANY(${n.employeeIds}::uuid[]) AND user_id IS NOT NULL`;
      for (const r of rows) userIds.add(r.user_id);
    }
    if (!userIds.size) return { delivered: 0 };
    const [type] = await db.$queryRaw<{ enabled: boolean; email: boolean }[]>`SELECT enabled, email FROM notification_types WHERE kind = ${n.kind}`;
    const enabled = type?.enabled ?? info.defaultEnabled;
    const byEmail = info.emailAvailable && (type?.email ?? info.defaultEmail);
    const users = await db.$queryRaw<{ id: string; full_name: string; email: string | null; pref: boolean | null }[]>`
      SELECT u.id, u.full_name, u.email, (SELECT p.email FROM notification_preferences p WHERE p.user_id = u.id AND p.kind = ${n.kind}) AS pref
        FROM school_users u WHERE u.id = ANY(${[...userIds]}::uuid[]) AND u.status = 'ACTIVE'`;
    const title = n.title.slice(0, 200);
    const body = n.body?.slice(0, 1000) ?? null;
    let delivered = 0;
    for (const u of users) {
      const log = (channel: "IN_APP" | "EMAIL", status: "SENT" | "FAILED" | "SKIPPED", notificationId: string | null, destination: string | null, error: string | null) =>
        db.$executeRaw`INSERT INTO notification_deliveries (id, audience, notification_id, recipient_id, recipient_name, kind, title, channel, destination, status, error, created_at)
                       VALUES (${randomUUID()}::uuid, 'STAFF', ${notificationId}::uuid, ${u.id}::uuid, ${u.full_name}, ${n.kind}, ${title}, ${channel}, ${destination}, ${status}, ${error}, ${now})`;
      if (!enabled) {
        await log("IN_APP", "SKIPPED", null, null, "Tipo desligado pelo colégio");
        continue;
      }
      // dedupe: a mesma chave já entregue a esta pessoa → nada de novo (nem histórico)
      const rows = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO staff_notifications (id, user_id, kind, title, body, link, dedupe_key, created_at)
        VALUES (${randomUUID()}::uuid, ${u.id}::uuid, ${n.kind}, ${title}, ${body}, ${n.link ?? null}, ${n.dedupeKey ?? null}, ${now})
        ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`;
      const id = rows[0]?.id;
      if (!id) continue;
      delivered++;
      await log("IN_APP", "SENT", id, null, null);
      if (!byEmail) continue;
      if (u.pref === false) {
        await log("EMAIL", "SKIPPED", id, u.email, "Recusado nas preferências");
        continue;
      }
      if (!u.email) {
        await log("EMAIL", "SKIPPED", id, null, "Sem email na conta");
        continue;
      }
      const url = n.link ? `${this.portalUrlTemplate.replace("{slug}", tenant.slug)}${n.link}` : null;
      try {
        await this.mailer.send({
          to: { email: u.email, name: u.full_name },
          subject: `${title} · ${tenant.name ?? "EduFlow"}`,
          html: frame(tenant.name ?? "EduFlow", title, body ?? "", url),
          text: `${title}\n\n${body ?? ""}${url ? `\n\nAbrir no portal: ${url}` : ""}`,
          tags: [`notify-${n.kind.toLowerCase()}`],
        });
        await log("EMAIL", "SENT", id, u.email, null);
      } catch (e) {
        this.logger.warn(`Email de ${n.kind} falhou: ${(e as Error).message}`);
        await log("EMAIL", "FAILED", id, u.email, String((e as Error).message).slice(0, 300));
      }
    }
    return { delivered };
  }
}
