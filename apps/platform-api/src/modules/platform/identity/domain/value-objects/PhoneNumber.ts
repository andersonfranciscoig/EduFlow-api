import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../errors";

/** Número de telefone normalizado no formato E.164 (ex.: +244923456789). */
export class PhoneNumber {
  private constructor(readonly value: string) {}

  /**
   * @param defaultCountryCode indicativo aplicado quando o número vem sem ele (ex.: "244").
   */
  static create(raw: string, defaultCountryCode: string): Result<PhoneNumber, IdentityError> {
    const compact = raw.trim().replace(/[\s().-]/g, "");
    let digits: string;

    if (compact.startsWith("+")) digits = compact.slice(1);
    else if (compact.startsWith("00")) digits = compact.slice(2);
    else digits = `${defaultCountryCode}${compact.replace(/^0+/, "")}`;

    if (!/^[1-9]\d{7,14}$/.test(digits)) {
      return fail(identityError("INVALID_PHONE", "Este número de telefone não parece válido."));
    }
    return ok(new PhoneNumber(`+${digits}`));
  }

  equals(other: PhoneNumber): boolean {
    return this.value === other.value;
  }
}
