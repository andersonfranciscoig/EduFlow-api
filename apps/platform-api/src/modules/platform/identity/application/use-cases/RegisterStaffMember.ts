import type { Clock, IdGenerator } from "../../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import type { StaffRole, StaffStatus } from "../../domain/access-control";
import { identityError, type IdentityError } from "../../domain/errors";
import { StaffMember } from "../../domain/StaffMember";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { FullName } from "../../domain/value-objects/FullName";
import { parseLoginIdentifier } from "../../domain/value-objects/LoginIdentifier";
import { PlainPassword } from "../../domain/value-objects/Password";
import type { IdentitySettings, PasswordHasher, StaffPrincipal } from "../ports";

export interface RegisterOutput {
  principal: StaffPrincipal;
  role: StaffRole;
  status: StaffStatus;
}

export class RegisterStaffMember {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settings: IdentitySettings,
  ) {}

  async execute(input: {
    identifier: string;
    fullName: string;
    password: string;
  }): Promise<Result<RegisterOutput, IdentityError>> {
    const identifier = parseLoginIdentifier(input.identifier, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return identifier;

    const fullName = FullName.create(input.fullName);
    if (!fullName.ok) return fullName;

    const password = PlainPassword.create(input.password);
    if (!password.ok) return password;

    if (await this.members.findByIdentifier(identifier.value)) {
      return fail(
        identityError("ACCOUNT_ALREADY_EXISTS", "Já existe uma conta com este identificador. Inicie sessão."),
      );
    }

    const member = StaffMember.register({
      id: this.ids.next(),
      fullName: fullName.value,
      identifier: identifier.value,
      passwordHash: await this.hasher.hash(password.value.value),
      isFirstMember: (await this.members.count()) === 0,
      now: this.clock.now(),
    });

    await this.members.save(member);

    return ok({
      principal: { id: member.id, fullName: member.fullName.value, role: member.role },
      role: member.role,
      status: member.status,
    });
  }
}
