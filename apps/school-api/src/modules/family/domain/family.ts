/**
 * FAMÍLIAS — contas, alunos e encarregados.
 *   conta de família   separada das contas da equipa: email + senha + código por email a cada
 *                      entrada (2.º fator). Nunca recebe permissões de gestão do colégio.
 *   aluno              entidade académica; NÃO é uma conta. O maior de idade pode ser titular
 *                      da sua conta (students.account_id).
 *   encarregado        pode ter conta (guardians.account_id) e vários educandos.
 *   maioridade         calculada AQUI pela data de nascimento e pelo dia de hoje em Luanda —
 *                      nunca vem do navegador. < 18 anos = menor.
 *   quem gere o aluno  menor: o encarregado com can_manage (o principal);
 *                      maior: só o próprio (o encarregado não ganha acesso automático).
 */
import { DomainError } from "../../../../../../libs/kernel/src/domain/DomainError";

export type FamilyErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_SUSPENDED"
  | "EMAIL_CODE_EXPIRED"
  | "INVALID_EMAIL_CODE"
  | "EMAIL_CODE_COOLDOWN"
  | "EMAIL_CODE_LIMIT"
  | "EMAIL_NOT_SENT"
  | "INVALID_CHALLENGE"
  | "STUDENT_NOT_FOUND";
export type FamilyError = DomainError<FamilyErrorCode>;
export const familyError = (code: FamilyErrorCode, message: string, meta?: Record<string, unknown>): FamilyError => new DomainError(code, message, meta);

export type FamilyStatus = "PENDING" | "ACTIVE" | "SUSPENDED";
export type CodePurpose = "ACTIVATION" | "LOGIN" | "RECOVERY";

/** Entradas erradas seguidas que bloqueiam a conta durante LOCK_MINUTES. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** Sessão da família: 12 h (renovada enquanto se usa). */
export const SESSION_HOURS = 12;

export const ADULT_AGE = 18;

/** "AAAA-MM-DD" de hoje em Luanda. */
export const luandaToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** Anos completos numa data (ISO). */
export function ageOn(birthDate: string, today: string) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export const isAdult = (birthDate: string, today: string) => ageOn(birthDate, today) >= ADULT_AGE;

export const STUDENT_STATUS_LABELS = {
  CANDIDATE: "Candidato",
  ENROLLED: "Matriculado",
  SUSPENDED: "Suspenso",
  TRANSFERRED: "Transferido",
  LEFT: "Saiu do colégio",
  GRADUATED: "Concluiu",
} as const;
export type StudentStatus = keyof typeof STUDENT_STATUS_LABELS;

/** A relação que liga uma conta a um aluno (para decidir o acesso). */
export interface StudentLink {
  /** a conta é o próprio aluno (titular) */
  self: boolean;
  /** a conta é um encarregado com can_manage */
  managingGuardian: boolean;
}

/**
 * A conta pode ver e gerir este aluno?
 *   o próprio titular: sempre;
 *   o encarregado que gere: só enquanto o aluno for menor de idade.
 */
export const canAccessStudent = (link: StudentLink, birthDate: string, today: string) => link.self || (link.managingGuardian && !isAdult(birthDate, today));

/** "ma••••@exemplo.ao" */
export const maskEmail = (email: string) => {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(2, Math.min(6, user.length - 2)))}@${domain}`;
};
