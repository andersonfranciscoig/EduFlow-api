import { ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import type { IdentityError } from "../../domain/errors";
import type { StaffMemberRepository } from "../../domain/StaffMemberRepository";
import { parseLoginIdentifier, type IdentifierKind } from "../../domain/value-objects/LoginIdentifier";
import type { IdentitySettings } from "../ports";

export interface IdentifyOutput {
  exists: boolean;
  kind: IdentifierKind;
  /** Identificador normalizado (email minúsculo / telefone E.164). */
  normalized: string;
  /** Primeiro nome, para cumprimentar no passo da senha. */
  firstName: string | null;
}

/**
 * Passo 1 do login/registo: verifica se o email/telefone pertence a alguém.
 */
export class IdentifyStaffMember {
  constructor(
    private readonly members: StaffMemberRepository,
    private readonly settings: IdentitySettings,
  ) {}

  async execute(input: { identifier: string }): Promise<Result<IdentifyOutput, IdentityError>> {
    const identifier = parseLoginIdentifier(input.identifier, this.settings.defaultPhoneCountryCode);
    if (!identifier.ok) return identifier;

    const member = await this.members.findByIdentifier(identifier.value);
    return ok({
      exists: member !== null,
      kind: identifier.value.kind,
      normalized: identifier.value.value,
      firstName: member?.fullName.firstName ?? null,
    });
  }
}
