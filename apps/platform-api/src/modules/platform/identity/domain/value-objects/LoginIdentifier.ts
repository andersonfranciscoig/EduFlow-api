import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../errors";
import { EmailAddress } from "./EmailAddress";
import { PhoneNumber } from "./PhoneNumber";

export type IdentifierKind = "email" | "phone";

/**
 * Aquilo que a pessoa escreve para se identificar: email OU telefone.
 * É a primeira etapa de qualquer fluxo de autenticação.
 */
export type LoginIdentifier =
  | { readonly kind: "email"; readonly email: EmailAddress; readonly value: string }
  | { readonly kind: "phone"; readonly phone: PhoneNumber; readonly value: string };

/** Heurística partilhada com a UI para mostrar o ícone certo enquanto se escreve. */
export function detectIdentifierKind(raw: string): IdentifierKind | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("@") || /[a-z]/i.test(value)) return "email";
  if (/^[+\d\s().-]+$/.test(value)) return "phone";
  return null;
}

export function parseLoginIdentifier(
  raw: string,
  defaultCountryCode: string,
): Result<LoginIdentifier, IdentityError> {
  const kind = detectIdentifierKind(raw);

  if (kind === "email") {
    const email = EmailAddress.create(raw);
    return email.ok ? ok({ kind, email: email.value, value: email.value.value }) : email;
  }
  if (kind === "phone") {
    const phone = PhoneNumber.create(raw, defaultCountryCode);
    return phone.ok ? ok({ kind, phone: phone.value, value: phone.value.value }) : phone;
  }
  return fail(identityError("INVALID_IDENTIFIER", "Introduza um email ou número de telefone."));
}
