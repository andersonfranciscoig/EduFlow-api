import type { Permission, StaffRole } from "../domain/access-control";
import type { StaffActivityType } from "../domain/events";

/**
 * Portas da camada de aplicação — interfaces que a infraestrutura implementa.
 * Os casos de uso dependem só destas abstrações (inversão de dependências).
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

/** Tokens de acesso: só existem para uma sessão aberta (após a 2FA). */
export interface AccessTokenService {
  issue(principal: StaffPrincipal, sessionId: string): Promise<{ accessToken: string; expiresIn: number }>;
  verify(token: string): Promise<{ principal: StaffPrincipal; sessionId: string } | null>;
}

/**
 * "Bilhete" de curta duração entre a senha e a 2FA: prova que a senha estava
 * certa, mas não dá acesso a nada além de concluir a 2FA.
 */
export type ChallengePurpose = "mfa-verify" | "mfa-setup";
export interface ChallengeService {
  issue(staffId: string, purpose: ChallengePurpose): Promise<string>;
  verify(token: string, purpose: ChallengePurpose): Promise<string | null>;
}

/** Cifra simétrica para segredos guardados na BD. */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface TotpService {
  generateSecret(): string;
  otpauthUrl(secret: string, account: string): string;
  /** Devolve o intervalo aceite, ou null. */
  verify(secret: string, code: string, at: number): number | null;
}

export interface RecoveryCodes {
  generate(): string[];
  hash(code: string): string;
}

/** De onde vem o pedido (para a lista de sessões). */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** Configuração de que os casos de uso precisam. */
export interface IdentitySettings {
  defaultPhoneCountryCode: string;
}

/** Membro autenticado — o que o token de acesso transporta. */
export interface StaffPrincipal {
  id: string;
  fullName: string;
  role: StaffRole;
}

/** Membro autenticado com o acesso já resolvido a partir da BD (por pedido). */
export interface StaffAccess extends StaffPrincipal {
  permissions: Permission[];
  sessionId: string;
  /** 2FA verificada há menos de 10 minutos (necessário para ações sensíveis). */
  mfaFresh: boolean;
}

/** Entrada do histórico de atividade, pronta a mostrar. */
export interface StaffActivityEntry {
  id: string;
  type: StaffActivityType;
  occurredAt: string;
  details: Record<string, unknown> | null;
  /** O membro consultado foi quem fez a ação (true) ou quem a sofreu (false)? */
  performedByMember: boolean;
  actor: { id: string; fullName: string } | null;
  subject: { id: string; fullName: string };
}

/** Read model do histórico (consulta otimizada, fora do agregado). */
export interface StaffActivityQuery {
  forMember(memberId: string, options: { limit: number; before?: Date }): Promise<StaffActivityEntry[]>;
}

/** Tokens de injeção de dependências (as interfaces não existem em runtime). */
export const IDENTITY_TOKENS = {
  StaffActivityQuery: Symbol("StaffActivityQuery"),
  StaffMemberRepository: Symbol("StaffMemberRepository"),
  StaffSessionRepository: Symbol("StaffSessionRepository"),
  PasswordHasher: Symbol("PasswordHasher"),
  AccessTokenService: Symbol("AccessTokenService"),
  ChallengeService: Symbol("ChallengeService"),
  SecretCipher: Symbol("SecretCipher"),
  TotpService: Symbol("TotpService"),
  RecoveryCodes: Symbol("RecoveryCodes"),
  IdentitySettings: Symbol("IdentitySettings"),
  Clock: Symbol("Clock"),
  IdGenerator: Symbol("IdGenerator"),
} as const;
