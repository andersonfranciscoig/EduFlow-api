import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../domain/errors";
import type {
  ClientInfo,
  SchoolAccess,
  SupportNotifier,
  SupportTicketVerifier,
  SupportTokenService,
  TenantScope,
} from "./ports";

/** Uma sessão de suporte dura no máximo 1 hora (e nunca passa do fim da autorização). */
export const SUPPORT_SESSION_MAX_MS = 60 * 60_000;
/** Por quanto tempo o colégio pode autorizar (dias). */
export const SUPPORT_GRANT_DAYS = [1, 7, 30] as const;
const TOUCH_EVERY_MS = 60_000;
const DAY_MS = 86_400_000;

export const SUPPORT_MODE_LABELS = { READ: "Só leitura", WRITE: "Com edição" } as const;

/**
 * Acesso da equipa EduFlow ao portal do colégio (suporte).
 *
 *  - O COLÉGIO decide: sem autorização ativa (diretor/responsável), ninguém entra.
 *    Exceção: emergência pedida por um ADMIN da EduFlow — sempre avisada por email.
 *  - Bilhete de 60 s, assinado pela plataforma (aqui só a chave pública), ligado
 *    a ESTE colégio e de uso único (o id fica guardado).
 *  - Sessão própria (não é uma conta do colégio), no máximo 1 h, só leitura por omissão.
 *  - Cada entrada fica registada na BD do colégio e é avisada aos diretores.
 */
export class SupportAccess {
  constructor(
    private readonly tickets: SupportTicketVerifier,
    private readonly tokens: SupportTokenService,
    private readonly notifier: SupportNotifier,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async exchange(scope: TenantScope, ticket: string, client: ClientInfo): Promise<Result<{ accessToken: string; expiresIn: number }, IdentityError>> {
    const claims = await this.tickets.verify(ticket);
    if (!claims || claims.schoolId !== scope.schoolId) {
      return fail(identityError("INVALID_SUPPORT_TICKET", "O pedido de acesso do suporte é inválido ou expirou. Peça um novo no painel."));
    }
    const now = this.clock.now();
    const grant = await scope.support.activeGrant(now);
    if (!grant && !claims.emergency) {
      return fail(identityError("SUPPORT_NOT_AUTHORIZED", "Este colégio não autorizou o acesso do suporte EduFlow. O diretor pode autorizar no portal."));
    }

    const limit = now.getTime() + SUPPORT_SESSION_MAX_MS;
    const expiresAt = new Date(grant && !claims.emergency ? Math.min(limit, grant.expiresAt.getTime()) : limit);
    const sessionId = this.ids.next();
    const created = await scope.support.createSession({
      id: sessionId,
      ticketId: claims.ticketId,
      staffId: claims.staffId,
      staffName: claims.staffName,
      staffEmail: claims.staffEmail,
      mode: claims.mode,
      emergency: claims.emergency,
      reason: claims.reason,
      grantId: grant?.id ?? null,
      ip: client.ip,
      userAgent: client.userAgent,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    });
    if (!created) return fail(identityError("SUPPORT_TICKET_USED", "Este pedido de acesso já foi usado. Peça um novo no painel."));

    await scope.support.record("SUPPORT_SESSION_STARTED", sessionId, null, {
      staffName: claims.staffName,
      mode: claims.mode,
      emergency: claims.emergency,
      reason: claims.reason,
      expiresAt: expiresAt.toISOString(),
    }, now);

    // aviso aos diretores — melhor esforço (nunca impede a entrada… nem a esconde: fica no histórico)
    const to = await scope.support.recipients();
    if (to.length) {
      await this.notifier
        .supportStarted({ to, school: { name: scope.schoolName, slug: scope.slug }, staffName: claims.staffName, mode: claims.mode, emergency: claims.emergency, reason: claims.reason, expiresAt })
        .catch(() => undefined);
    }

    const seconds = Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    return ok(await this.tokens.issue(sessionId, scope.schoolId, seconds));
  }

  /** Acesso de um pedido com token de suporte (por pedido, na BD do colégio). */
  async resolve(scope: TenantScope, sessionId: string): Promise<SchoolAccess | null> {
    const now = this.clock.now();
    const session = await scope.support.findSession(sessionId);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    // a autorização tem de continuar ativa (o colégio pode retirá-la a qualquer momento)
    if (!session.emergency) {
      const grant = await scope.support.activeGrant(now);
      if (!grant || grant.id !== session.grantId) return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) await scope.support.touchSession(session.id, now);
    return {
      id: session.staffId,
      fullName: session.staffName,
      // vê o que um diretor vê; o modo (READ) é aplicado pelo guard a todos os pedidos
      role: "DIRETOR",
      isOwner: false,
      schoolId: scope.schoolId,
      sessionId: session.id,
      mfaFresh: false,
      support: { staffName: session.staffName, mode: session.mode, emergency: session.emergency, reason: session.reason, expiresAt: session.expiresAt },
    };
  }

  async signOut(scope: TenantScope, sessionId: string) {
    await scope.support.revokeSession(sessionId, "Saiu", this.clock.now());
  }

  // ================================================================ o colégio decide

  private canManage(user: SchoolAccess): Result<void, IdentityError> {
    if (user.support) return fail(identityError("SUPPORT_FORBIDDEN", "O suporte não pode alterar a sua própria autorização."));
    if (!user.isOwner && user.role !== "DIRETOR") return fail(identityError("SUPPORT_FORBIDDEN", "Só o diretor ou o responsável do colégio decide o acesso do suporte."));
    return ok(undefined);
  }

  async status(scope: TenantScope, user: SchoolAccess) {
    const allowed = this.canManage(user);
    if (!allowed.ok) return allowed;
    const now = this.clock.now();
    const [grant, sessions] = await Promise.all([scope.support.activeGrant(now), scope.support.recentSessions(20)]);
    return ok({
      grant: grant ? { expiresAt: grant.expiresAt.toISOString(), grantedBy: grant.grantedBy, createdAt: grant.createdAt.toISOString() } : null,
      durations: SUPPORT_GRANT_DAYS,
      sessions: sessions.map((s) => ({
        id: s.id,
        staffName: s.staffName,
        mode: s.mode,
        modeLabel: SUPPORT_MODE_LABELS[s.mode],
        emergency: s.emergency,
        reason: s.reason,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        endedAt: s.revokedAt?.toISOString() ?? null,
        active: !s.revokedAt && s.expiresAt > now,
      })),
    });
  }

  async grant(scope: TenantScope, user: SchoolAccess, days: number) {
    const allowed = this.canManage(user);
    if (!allowed.ok) return allowed;
    if (!(SUPPORT_GRANT_DAYS as readonly number[]).includes(days)) return fail(identityError("INVALID_STATE", "Escolha 1, 7 ou 30 dias."));
    const now = this.clock.now();
    // uma autorização de cada vez: a nova substitui a anterior (e termina as sessões dela)
    await scope.support.revokeAll({ revokedById: user.id, reason: "Autorização substituída", now });
    const id = this.ids.next();
    await scope.support.grant({ id, grantedById: user.id, expiresAt: new Date(now.getTime() + days * DAY_MS), now });
    await scope.support.record("SUPPORT_ACCESS_GRANTED", id, user.id, { days }, now);
    return this.status(scope, user);
  }

  async revoke(scope: TenantScope, user: SchoolAccess) {
    const allowed = this.canManage(user);
    if (!allowed.ok) return allowed;
    const now = this.clock.now();
    const ended = await scope.support.revokeAll({ revokedById: user.id, reason: "Acesso retirado pelo colégio", now });
    await scope.support.record("SUPPORT_ACCESS_REVOKED", user.id, user.id, { endedSessions: ended }, now);
    return this.status(scope, user);
  }
}
