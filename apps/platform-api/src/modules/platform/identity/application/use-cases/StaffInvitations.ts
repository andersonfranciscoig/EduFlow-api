import type { Clock, IdGenerator } from "../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { ROLE_LABELS, type StaffRole } from "../../domain/access-control";
import { identityError, type IdentityError } from "../../domain/errors";
import { StaffInvitation, type StaffInvitationRepository } from "../../domain/StaffInvitation";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { EmailAddress } from "../../domain/value-objects/EmailAddress";
import { parseLoginIdentifier } from "../../domain/value-objects/LoginIdentifier";
import type { IdentitySettings, StaffAccess } from "../ports";

export interface InvitationMailer {
  send(input: { to: string; invitedBy: string; roleLabel: string; link: string; expiresAt: Date }): Promise<void>;
}

export interface InvitationTokens {
  generate(): { token: string; hash: string };
  hash(token: string): string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: StaffRole;
  roleLabel: string;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

const view = (i: StaffInvitation, invitedBy: string | null): InvitationView => ({
  id: i.id,
  email: i.email,
  role: i.role,
  roleLabel: ROLE_LABELS[i.role],
  invitedBy,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.snapshot.createdAt.toISOString(),
});

/**
 * Convites para a equipa: o painel da equipa só aceita contas novas de quem
 * foi convidado por um administrador (exceto o primeiro membro da plataforma).
 */
export class StaffInvitations {
  constructor(
    private readonly invitations: StaffInvitationRepository,
    private readonly members: StaffMemberRepository,
    private readonly mailer: InvitationMailer,
    private readonly tokens: InvitationTokens,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings & { signUpUrl: string },
  ) {}

  async invite(input: { email: string; role: StaffRole }, actor: StaffAccess): Promise<Result<InvitationView, IdentityError>> {
    const email = EmailAddress.create(input.email);
    if (!email.ok) return email;
    if (input.role === "ADMIN" && actor.role !== "ADMIN") {
      return fail(identityError("ADMIN_REQUIRED", "Só um administrador pode convidar outro administrador."));
    }
    const identifier = parseLoginIdentifier(email.value.value, this.settings.defaultPhoneCountryCode);
    if (identifier.ok && (await this.members.findByIdentifier(identifier.value))) {
      return fail(identityError("ACCOUNT_ALREADY_EXISTS", "Esta pessoa já tem conta na equipa."));
    }

    const now = this.clock.now();
    // um convite novo substitui os anteriores (o link antigo deixa de funcionar)
    for (const old of await this.invitations.pendingForEmail(email.value.value, now)) {
      old.revoke(now);
      await this.invitations.save(old);
    }
    const token = this.tokens.generate();
    const invitation = StaffInvitation.create({ id: this.ids.next(), email: email.value.value, role: input.role, tokenHash: token.hash, invitedById: actor.id, now });
    await this.invitations.save(invitation);

    const link = `${this.settings.signUpUrl}?convite=${encodeURIComponent(token.token)}`;
    await this.mailer.send({ to: invitation.email, invitedBy: actor.fullName, roleLabel: ROLE_LABELS[input.role], link, expiresAt: invitation.expiresAt });
    return ok(view(invitation, actor.fullName));
  }

  async listPending(): Promise<InvitationView[]> {
    return (await this.invitations.listPending(this.clock.now())).map((r) => view(r.invitation, r.invitedByName));
  }

  async revoke(id: string): Promise<Result<void, IdentityError>> {
    const invitation = await this.invitations.findById(id);
    if (!invitation || !invitation.isPending(this.clock.now())) return fail(identityError("INVITATION_INVALID", "Este convite já não está pendente."));
    invitation.revoke(this.clock.now());
    await this.invitations.save(invitation);
    return ok(undefined);
  }

  /** Página "criar conta" aberta pelo link do convite. */
  async lookup(token: string): Promise<Result<{ email: string; role: StaffRole; roleLabel: string; invitedBy: string | null }, IdentityError>> {
    const invitation = await this.byToken(token);
    if (!invitation) return fail(identityError("INVITATION_INVALID", "Este convite expirou ou já foi usado. Peça um novo a um administrador."));
    const inviter = await this.members.findById(invitation.invitedById);
    return ok({ email: invitation.email, role: invitation.role, roleLabel: ROLE_LABELS[invitation.role], invitedBy: inviter?.fullName.value ?? null });
  }

  /** Convite válido para criar conta com este email (pelo link, ou um pendente para o email). */
  async forSignUp(email: string, token?: string): Promise<StaffInvitation | null> {
    if (token) {
      const invitation = await this.byToken(token);
      return invitation && invitation.email === email ? invitation : null;
    }
    return this.invitations.findPendingByEmail(email, this.clock.now());
  }

  async markAccepted(invitation: StaffInvitation) {
    invitation.accept(this.clock.now());
    await this.invitations.save(invitation);
  }

  private async byToken(token: string) {
    if (!token || token.length < 20) return null;
    const invitation = await this.invitations.findByTokenHash(this.tokens.hash(token));
    return invitation?.isPending(this.clock.now()) ? invitation : null;
  }
}
