import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../errors";

export class FullName {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<FullName, IdentityError> {
    const normalized = raw.trim().replace(/\s+/g, " ");
    if (normalized.length < 3 || normalized.length > 120 || !/\p{L}/u.test(normalized)) {
      return fail(identityError("INVALID_NAME", "Escreva o seu nome (pelo menos 3 letras)."));
    }
    return ok(new FullName(normalized));
  }

  get firstName(): string {
    return this.value.split(" ")[0];
  }
}
