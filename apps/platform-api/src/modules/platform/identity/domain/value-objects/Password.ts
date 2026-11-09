import { fail, ok, type Result } from "../../../../../../../../libs/kernel/src/domain/Result";
import { identityError, type IdentityError } from "../errors";

/**
 * Política de senha. É código de domínio puro (sem dependências), por isso
 * a UI reutiliza `passwordRules` para mostrar a checklist em tempo real.
 */
export const passwordRules = [
  { id: "length", label: "Pelo menos 8 caracteres", test: (p: string) => p.length >= 8 },
  { id: "letter", label: "Uma letra", test: (p: string) => /\p{L}/u.test(p) },
  { id: "number", label: "Um número", test: (p: string) => /\d/.test(p) },
  { id: "mixed", label: "Maiúsculas e minúsculas", test: (p: string) => /\p{Lu}/u.test(p) && /\p{Ll}/u.test(p) },
] as const;

/** Regras obrigatórias (as restantes só aumentam a força). */
const REQUIRED_RULES = new Set(["length", "letter", "number"]);

/** Força de 0 a 4 — usada pelo medidor visual. */
export function passwordStrength(password: string): number {
  if (!password) return 0;
  let score = passwordRules.filter((r) => r.test(password)).length;
  if (password.length >= 12 && /[^\p{L}\d]/u.test(password)) score = Math.min(4, score + 1);
  if (password.length < 8) score = Math.min(score, 1);
  return score;
}

export class PlainPassword {
  private constructor(readonly value: string) {}

  static create(raw: string): Result<PlainPassword, IdentityError> {
    const broken = passwordRules.filter((r) => REQUIRED_RULES.has(r.id) && !r.test(raw));
    if (broken.length > 0 || raw.length > 128) {
      return fail(identityError("WEAK_PASSWORD", "A senha precisa de 8+ caracteres, com letras e números."));
    }
    return ok(new PlainPassword(raw));
  }
}
