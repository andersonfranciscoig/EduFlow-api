import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "./errors";

import { PROVINCES } from "../../../../../../../libs/kernel/src/domain/angola";

/** Províncias de Angola (lista partilhada em libs/kernel). */
export { PROVINCES };

export interface SchoolData {
  name: string;
  nif: string;
  phone: string;
  province: string;
  municipality: string;
  address: string;
}

export interface OwnerData {
  name: string;
  email: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Email corporativo — recusa os domínios de email pessoal mais comuns. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

/** Com email pessoal, o colégio tem este prazo para passar a um email corporativo. */
export const CORPORATE_EMAIL_DEADLINE_DAYS = 30;

export const isPersonalEmail = (email: string) => PERSONAL_DOMAINS.has(email.split("@")[1] ?? "");

/** Email do responsável no registo: corporativo OU pessoal (com prazo de 30 dias para mudar). */
export function normalizeOwnerEmail(raw: string): Result<string, SchoolError> {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    return fail(schoolError("INVALID_OWNER", "Este email não parece válido."));
  }
  return ok(email);
}

/** Só email corporativo (ex.: ao trocar o email pessoal pelo do colégio). */
export function normalizeCorporateEmail(raw: string): Result<string, SchoolError> {
  const email = normalizeOwnerEmail(raw);
  if (!email.ok) return email;
  if (isPersonalEmail(email.value)) {
    return fail(
      schoolError("INVALID_OWNER", "Use o email corporativo do colégio (ex.: direcao@seucolegio.ao), não um email pessoal."),
    );
  }
  return email;
}

export function normalizePhone(raw: string, defaultCountryCode: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, "");
  const digits = compact.startsWith("+")
    ? compact.slice(1)
    : compact.startsWith("00")
      ? compact.slice(2)
      : `${defaultCountryCode}${compact.replace(/^0+/, "")}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/**
 * Slug a partir do nome: "Colégio São José" → "colegio-sao-jose".
 * Usado no endereço do portal do colégio (ex.: colegio-sao-jose.eduflow.ao).
 */
export function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `colegio-${base || "novo"}`;
}

/** NIF angolano: 10 dígitos (empresas) ou até 14 caracteres alfanuméricos. */
export function normalizeNif(raw: string): string | null {
  const nif = raw.replace(/[\s.-]/g, "").toUpperCase();
  return /^[0-9A-Z]{9,14}$/.test(nif) && /\d{6,}/.test(nif) ? nif : null;
}

export function validateSchoolData(input: SchoolData, defaultCountryCode: string): Result<SchoolData, SchoolError> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 3) return fail(schoolError("INVALID_SCHOOL_DATA", "Indique o nome do colégio."));

  const nif = normalizeNif(input.nif);
  if (!nif) return fail(schoolError("INVALID_SCHOOL_DATA", "NIF inválido."));

  const phone = normalizePhone(input.phone, defaultCountryCode);
  if (!phone) return fail(schoolError("INVALID_SCHOOL_DATA", "Número de telefone inválido."));

  if (!(PROVINCES as readonly string[]).includes(input.province)) {
    return fail(schoolError("INVALID_SCHOOL_DATA", "Escolha a província."));
  }
  const municipality = input.municipality.trim();
  if (municipality.length < 2) return fail(schoolError("INVALID_SCHOOL_DATA", "Indique o município."));
  const address = input.address.trim();
  if (address.length < 5) return fail(schoolError("INVALID_SCHOOL_DATA", "Indique a morada do colégio."));

  return ok({ name, nif, phone, province: input.province, municipality, address });
}

export function validateOwner(input: OwnerData & { password: string }): Result<OwnerData, SchoolError> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 3 || !/\p{L}/u.test(name)) {
    return fail(schoolError("INVALID_OWNER", "Indique o nome do responsável."));
  }
  const email = normalizeOwnerEmail(input.email);
  if (!email.ok) return email;
  const password = validateOwnerPassword(input.password);
  if (!password.ok) return password;
  return ok({ name, email: email.value });
}

export function validateOwnerPassword(p: string): Result<string, SchoolError> {
  if (p.length < 8 || p.length > 128 || !/\p{L}/u.test(p) || !/\d/.test(p)) {
    return fail(schoolError("INVALID_OWNER", "A senha precisa de 8+ caracteres, com letras e números."));
  }
  return ok(p);
}
