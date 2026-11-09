import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../errors";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<EmailAddress, IdentityError> {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
      return fail(identityError("INVALID_EMAIL", "Este email não parece válido."));
    }
    return ok(new EmailAddress(normalized));
  }

  equals(other: EmailAddress): boolean {
    return this.value === other.value;
  }
}
