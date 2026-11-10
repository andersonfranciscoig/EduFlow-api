import { DomainError } from "./DomainError";
import { fail, ok, type Result } from "./Result";

/**
 * Value objects de contacto e credenciais, partilhados pelos serviços que
 * autenticam pessoas (sem dependências de framework nem de outra app).
 */
export type ContactErrorCode = "INVALID_IDENTIFIER" | "INVALID_EMAIL" | "INVALID_PHONE" | "INVALID_NAME" | "WEAK_PASSWORD";
export type ContactError = DomainError<ContactErrorCode>;

const contactError = (code: ContactErrorCode, message: string): ContactError => new DomainError(code, message);

// ------------------------------------------------------------------ email

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class EmailAddress {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<EmailAddress, ContactError> {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
      return fail(contactError("INVALID_EMAIL", "Este email não parece válido."));
    }
    return ok(new EmailAddress(normalized));
  }

  /** "ana.paula@gmail.com" → "an•••@gmail.com" (para mostrar para onde foi um código). */
  get masked(): string {
    const [local, domain] = this.value.split("@");
    return `${local.slice(0, Math.min(2, local.length))}•••@${domain}`;
  }
}

// ------------------------------------------------------------------ telefone

/** Número de telefone normalizado no formato E.164 (ex.: +244923456789). */
export class PhoneNumber {
  private constructor(readonly value: string) {}

  /** @param defaultCountryCode indicativo aplicado quando o número vem sem ele (ex.: "244"). */
  static create(raw: string, defaultCountryCode: string): Result<PhoneNumber, ContactError> {
    const compact = raw.trim().replace(/[\s().-]/g, "");
    let digits: string;
    if (compact.startsWith("+")) digits = compact.slice(1);
    else if (compact.startsWith("00")) digits = compact.slice(2);
    else digits = `${defaultCountryCode}${compact.replace(/^0+/, "")}`;

    if (!/^[1-9]\d{7,14}$/.test(digits)) {
      return fail(contactError("INVALID_PHONE", "Este número de telefone não parece válido."));
    }
    return ok(new PhoneNumber(`+${digits}`));
  }
}

// ------------------------------------------------------------------ nome

export class FullName {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<FullName, ContactError> {
    const normalized = raw.trim().replace(/\s+/g, " ");
    if (normalized.length < 3 || normalized.length > 120 || !/\p{L}/u.test(normalized)) {
      return fail(contactError("INVALID_NAME", "Escreva o nome (pelo menos 3 letras)."));
    }
    return ok(new FullName(normalized));
  }

  get firstName(): string {
    return this.value.split(" ")[0];
  }
}

// ------------------------------------------------------------------ senha

/** Política de senha (a UI repete estas regras só para feedback imediato). */
export const passwordRules = [
  { id: "length", test: (p: string) => p.length >= 8 },
  { id: "letter", test: (p: string) => /\p{L}/u.test(p) },
  { id: "number", test: (p: string) => /\d/.test(p) },
] as const;

export class PlainPassword {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<PlainPassword, ContactError> {
    if (passwordRules.some((r) => !r.test(raw)) || raw.length > 128) {
      return fail(contactError("WEAK_PASSWORD", "A senha precisa de 8+ caracteres, com letras e números."));
    }
    return ok(new PlainPassword(raw));
  }
}

// ------------------------------------------------------------------ identificador de login

export type IdentifierKind = "email" | "phone";

/** O que a pessoa escreve para se identificar: email OU telefone. */
export type LoginIdentifier =
  | { readonly kind: "email"; readonly email: EmailAddress; readonly value: string }
  | { readonly kind: "phone"; readonly phone: PhoneNumber; readonly value: string };

export function detectIdentifierKind(raw: string): IdentifierKind | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes("@") || /[a-z]/i.test(value)) return "email";
  if (/^[+\d\s().-]+$/.test(value)) return "phone";
  return null;
}

export function parseLoginIdentifier(raw: string, defaultCountryCode: string): Result<LoginIdentifier, ContactError> {
  const kind = detectIdentifierKind(raw);
  if (kind === "email") {
    const email = EmailAddress.create(raw);
    return email.ok ? ok({ kind, email: email.value, value: email.value.value }) : email;
  }
  if (kind === "phone") {
    const phone = PhoneNumber.create(raw, defaultCountryCode);
    return phone.ok ? ok({ kind, phone: phone.value, value: phone.value.value }) : phone;
  }
  return fail(contactError("INVALID_IDENTIFIER", "Introduza um email ou número de telefone."));
}
