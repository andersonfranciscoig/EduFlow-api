import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { type Audience, CHANNEL_LABELS, DELIVERY_LABELS, isKind, type Kind, KINDS, STAFF_KINDS } from "../domain/catalog";
import type { PrismaNotificationsRepository } from "../infrastructure/prisma-notifications";

export type NotificationsErrorCode = "INVALID_INPUT" | "FORBIDDEN";
const err = (code: NotificationsErrorCode, message: string) => new DomainError(code, message);
type R<T> = Promise<Result<T, DomainError<NotificationsErrorCode>>>;

/** Quem pode configurar os tipos de notificação do colégio: a direção e o responsável (e o suporte em edição). */
export interface NotifyActor {
  id: string;
  role: string;
  isOwner: boolean;
  support?: { mode: "READ" | "WRITE" };
}
export const canConfigure = (a: NotifyActor) => (a.support ? a.support.mode === "WRITE" : a.isOwner || a.role === "DIRETOR");
const SUBJECT = "00000000-0000-0000-0000-00000000a0e1";

/**
 * Notificações da equipa: a caixa de cada pessoa e as suas preferências de email; e, para a
 * direção, os tipos que o colégio envia (na plataforma / email) e o histórico de envios.
 */
export class NotificationsCenter {
  constructor(private readonly clock: Clock) {}

  async inbox(repo: PrismaNotificationsRepository, userId: string) {
    const [items, unread] = await Promise.all([repo.inbox(userId, 100), repo.unread(userId)]);
    return { unread, items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.readAt, createdAt: n.createdAt.toISOString() })) };
  }

  unread = async (repo: PrismaNotificationsRepository, userId: string) => ({ unread: await repo.unread(userId) });

  async markRead(repo: PrismaNotificationsRepository, userId: string, ids: string[] | null) {
    const marked = await repo.markRead(userId, ids?.length ? ids : null, this.clock.now());
    return { marked, unread: await repo.unread(userId) };
  }

  /** As preferências de email da pessoa (só os tipos da equipa que o colégio envia por email). */
  async preferences(repo: PrismaNotificationsRepository, userId: string) {
    const [prefs, types] = await Promise.all([repo.preferences(userId), repo.types()]);
    return {
      items: STAFF_KINDS.map((k) => {
        const t = types.get(k);
        const enabled = t?.enabled ?? KINDS[k].defaultEnabled;
        const schoolEmail = KINDS[k].emailAvailable && (t?.email ?? KINDS[k].defaultEmail);
        return { kind: k, label: KINDS[k].label, hint: KINDS[k].hint, enabled, schoolEmail, email: prefs.get(k) ?? true };
      }),
    };
  }

  async setPreference(repo: PrismaNotificationsRepository, userId: string, kind: string, email: boolean): R<{ saved: true }> {
    if (!isKind(kind) || KINDS[kind].audience !== "STAFF") return fail(err("INVALID_INPUT", "Tipo de notificação desconhecido."));
    await repo.setPreference(userId, kind, email, this.clock.now());
    return ok({ saved: true });
  }

  async settings(repo: PrismaNotificationsRepository, actor: NotifyActor) {
    const [types, counts] = await Promise.all([repo.types(), repo.deliveryCounts()]);
    const list = (audience: Audience) =>
      (Object.keys(KINDS) as Kind[])
        .filter((k) => KINDS[k].audience === audience)
        .map((k) => {
          const t = types.get(k);
          const i = KINDS[k];
          return { kind: k, label: i.label, hint: i.hint, to: i.to, enabled: t?.enabled ?? i.defaultEnabled, email: i.emailAvailable && (t?.email ?? i.defaultEmail), emailAvailable: i.emailAvailable, updatedAt: t?.updatedAt.toISOString() ?? null, updatedBy: t?.updatedBy ?? null };
        });
    return { canManage: canConfigure(actor), staff: list("STAFF"), family: list("FAMILY"), last30: counts };
  }

  async setType(repo: PrismaNotificationsRepository, actor: NotifyActor, kind: string, input: { enabled: boolean; email: boolean }): R<{ saved: true }> {
    if (!canConfigure(actor)) return fail(err("FORBIDDEN", "Só a direção pode configurar as notificações do colégio."));
    if (!isKind(kind)) return fail(err("INVALID_INPUT", "Tipo de notificação desconhecido."));
    const i = KINDS[kind];
    const email = i.emailAvailable && input.email && input.enabled;
    const types = await repo.types();
    const before = { enabled: types.get(kind)?.enabled ?? i.defaultEnabled, email: i.emailAvailable && (types.get(kind)?.email ?? i.defaultEmail) };
    const now = this.clock.now();
    await repo.setType(kind, input.enabled, email, actor.id, now);
    await repo.record("NOTIFICATION_TYPE_UPDATED", SUBJECT, actor.id, { kind, before, after: { enabled: input.enabled, email } }, now);
    return ok({ saved: true });
  }

  async deliveries(repo: PrismaNotificationsRepository, input: { kind?: string; status?: string; channel?: string; audience?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = 30;
    const r = await repo.deliveries({
      kind: input.kind && isKind(input.kind) ? input.kind : undefined,
      status: input.status && input.status in DELIVERY_LABELS ? input.status : undefined,
      channel: input.channel && input.channel in CHANNEL_LABELS ? input.channel : undefined,
      audience: input.audience === "STAFF" || input.audience === "FAMILY" ? input.audience : undefined,
      page,
      pageSize,
    });
    return {
      page,
      pageSize,
      total: r.total,
      items: r.items.map((d) => ({
        id: d.id,
        audience: d.audience,
        audienceLabel: d.audience === "STAFF" ? "Equipa" : "Família",
        recipient: d.recipientName,
        kind: d.kind,
        kindLabel: isKind(d.kind) ? KINDS[d.kind].label : d.kind,
        title: d.title,
        channel: d.channel,
        channelLabel: CHANNEL_LABELS[d.channel as keyof typeof CHANNEL_LABELS] ?? d.channel,
        destination: d.destination,
        status: d.status,
        statusLabel: DELIVERY_LABELS[d.status as keyof typeof DELIVERY_LABELS] ?? d.status,
        error: d.error,
        createdAt: d.createdAt.toISOString(),
      })),
      kinds: (Object.keys(KINDS) as Kind[]).map((k) => ({ value: k, label: KINDS[k].label })),
      statuses: Object.entries(DELIVERY_LABELS).map(([value, label]) => ({ value, label })),
      channels: Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label })),
    };
  }
}
