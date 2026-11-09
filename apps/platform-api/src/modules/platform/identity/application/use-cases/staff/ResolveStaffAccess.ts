import type { Clock } from "../../../../../../../../../libs/kernel/src/application/ports";
import type { StaffMemberRepository } from "../../../domain/StaffMemberRepository";
import type { StaffSessionRepository } from "../../../domain/StaffSession";
import type { StaffAccess } from "../../ports";

const TOUCH_EVERY_MS = 60_000;

/**
 * Resolve o acesso real de um pedido autenticado, a partir da BD:
 *  - a SESSÃO tem de estar ativa (terminar a sessão invalida o token de imediato);
 *  - a conta tem de estar ativa (desativar tem efeito no pedido seguinte);
 *  - as permissões são as atuais (não as gravadas no token).
 */
export class ResolveStaffAccess {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly sessions: StaffSessionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: { id: string; sessionId: string }): Promise<StaffAccess | null> {
    const now = this.clock.now();
    const [member, session] = await Promise.all([this.members.findById(input.id), this.sessions.findById(input.sessionId)]);
    if (!member || member.status !== "ACTIVE" || !member.mfaEnabled) return null;
    if (!session || session.staffId !== member.id || !session.isActive(now)) return null;

    if (now.getTime() - session.snapshot.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await this.sessions.touch(session.id, now);
    }

    return {
      id: member.id,
      fullName: member.fullName.value,
      role: member.role,
      permissions: member.permissions,
      sessionId: session.id,
      mfaFresh: session.hasRecentMfa(now),
    };
  }
}
