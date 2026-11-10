import type { Clock, IdGenerator } from "../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import type { EmailVerificationService } from "../../../verification/application/EmailVerificationService";
import type { VerificationError } from "../../../verification/domain/errors";
import type { StaffRole, StaffStatus } from "../../domain/access-control";
import { identityError, type IdentityError } from "../../domain/errors";
import { StaffMember } from "../../domain/StaffMember";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { FullName } from "../../domain/value-objects/FullName";
import { parseLoginIdentifier } from "../../domain/value-objects/LoginIdentifier";
import { PlainPassword } from "../../domain/value-objects/Password";
import type { IdentitySettings, PasswordHasher, StaffPrincipal } from "../ports";
import type { StaffInvitations } from "./StaffInvitations";

export interface RegisterOutput {
  principal: StaffPrincipal;
  role: StaffRole;
  status: StaffStatus;
}

/** Criar conta da equipa — só com o email confirmado por código (StaffEmailAccess). */
export class RegisterStaffMember {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings,
    private readonly verification: EmailVerificationService,
    private readonly invitations: StaffInvitations,
  ) {}

  async execute(input: {
    identifier: string;
    fullName: string;
    password: string;
    /** Prova de que o email foi confirmado com o código (quem escreveu o email à mão). */
    emailProof?: string;
    /** Token do link do convite (o link chegou ao email → o email está provado). */
    inviteToken?: string;
  }): Promise<Result<RegisterOutput, IdentityError | VerificationError>> {
    const identifier = parseLoginIdentifier(input.identifier, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return identifier;
    if (identifier.value.kind !== "email") {
      return fail(identityError("INVALID_IDENTIFIER", "Para criar conta use o seu email — vai receber um código para o confirmar."));
    }

    const fullName = FullName.create(input.fullName);
    if (!fullName.ok) return fullName;

    const password = PlainPassword.create(input.password);
    if (!password.ok) return password;

    if (await this.members.findByIdentifier(identifier.value)) {
      return fail(
        identityError("ACCOUNT_ALREADY_EXISTS", "Já existe uma conta com este identificador. Inicie sessão."),
      );
    }

    // só quem foi convidado (exceto o primeiro membro da plataforma)
    const isFirstMember = (await this.members.count()) === 0;
    const invitation = isFirstMember ? null : await this.invitations.forSignUp(identifier.value.value, input.inviteToken);
    if (!isFirstMember && !invitation) {
      return fail(identityError("STAFF_NOT_INVITED", "Apenas pessoas autorizadas têm acesso a este painel."));
    }

    // o email está provado pelo link do convite, ou pela prova do código (uso único)
    if (!(invitation && input.inviteToken)) {
      const proof = await this.verification.consume({ purpose: "STAFF_SIGN_UP", email: identifier.value.value, proof: input.emailProof ?? "" });
      if (!proof.ok) return proof;
    }

    const member = StaffMember.register({
      id: this.ids.next(),
      fullName: fullName.value,
      identifier: identifier.value,
      passwordHash: await this.hasher.hash(password.value.value),
      isFirstMember,
      invitation: invitation ? { role: invitation.role, invitedById: invitation.invitedById } : null,
      now: this.clock.now(),
    });

    await this.members.save(member);
    if (invitation) await this.invitations.markAccepted(invitation);

    return ok({
      principal: { id: member.id, fullName: member.fullName.value, role: member.role },
      role: member.role,
      status: member.status,
    });
  }
}
