import type { EmailCodeRepository, SchoolSessionRepository, SchoolUserRepository } from "../domain/repositories";
import type { EmailCodePurpose, SchoolRole } from "../domain/SchoolUser";

/**
 * O colégio do pedido e os repositórios ligados à SUA base de dados.
 * Cada caso de uso recebe-o explicitamente: não há forma de usar a BD de
 * outro colégio por engano (nem estado partilhado entre pedidos).
 */
export interface TenantScope {
  schoolId: string;
  slug: string;
  schoolName: string;
  users: SchoolUserRepository;
  sessions: SchoolSessionRepository;
  codes: EmailCodeRepository;
}

/** Utilizador autenticado — o que o token transporta. */
export interface SchoolPrincipal {
  id: string;
  fullName: string;
  role: SchoolRole;
}

/** Utilizador autenticado com o acesso resolvido na BD (por pedido). */
export interface SchoolAccess extends SchoolPrincipal {
  schoolId: string;
  sessionId: string;
  isOwner: boolean;
  /** 2FA verificada há menos de 10 minutos (ações sensíveis). */
  mfaFresh: boolean;
}

/** Tokens de acesso: só para uma sessão aberta (após a 2FA) e só para UM colégio. */
export interface AccessTokenService {
  issue(principal: SchoolPrincipal, sessionId: string, schoolId: string): Promise<{ accessToken: string; expiresIn: number }>;
  verify(token: string): Promise<{ principal: SchoolPrincipal; sessionId: string; schoolId: string } | null>;
}

/**
 * "Bilhetes" de curta duração entre passos (senha → 2FA, código por email →
 * nova senha). Provam o passo anterior, mas não dão acesso a nada.
 */
export type ChallengePurpose = "mfa-verify" | "mfa-setup" | "activation" | "password-reset";
export interface ChallengeService {
  issue(userId: string, schoolId: string, purpose: ChallengePurpose): Promise<string>;
  verify(token: string, schoolId: string, purposes: ChallengePurpose[]): Promise<{ userId: string; purpose: ChallengePurpose } | null>;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface TotpService {
  generateSecret(): string;
  otpauthUrl(secret: string, account: string, issuer: string): string;
  verify(secret: string, code: string, at: number): number | null;
}

export interface RecoveryCodes {
  generate(): string[];
  hash(code: string): string;
}

/** Envio dos códigos por email (o modelo da mensagem é da infraestrutura). */
export interface CodeMailer {
  sendCode(input: {
    to: { email: string; name: string };
    school: { name: string; slug: string };
    purpose: EmailCodePurpose;
    code: string;
    validMinutes: number;
  }): Promise<void>;
}

/** De onde vem o pedido (para a lista de sessões). */
export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface IdentitySettings {
  defaultPhoneCountryCode: string;
}

/** Tokens de injeção de dependências (as interfaces não existem em runtime). */
export const IDENTITY_TOKENS = {
  AccessTokenService: Symbol("AccessTokenService"),
  ChallengeService: Symbol("ChallengeService"),
  PasswordHasher: Symbol("PasswordHasher"),
  SecretCipher: Symbol("SecretCipher"),
  TotpService: Symbol("TotpService"),
  RecoveryCodes: Symbol("RecoveryCodes"),
  CodeMailer: Symbol("CodeMailer"),
  IdentitySettings: Symbol("IdentitySettings"),
  Clock: Symbol("Clock"),
  IdGenerator: Symbol("IdGenerator"),
} as const;
