import type { LoginIdentifier } from "../../../../../../libs/kernel/src/domain/contact";
import type { OtpStats } from "../../../../../../libs/kernel/src/domain/email-otp";
import type { EmailCode } from "./EmailCode";
import type { SchoolSession } from "./SchoolSession";
import type { EmailCodePurpose, SchoolUser } from "./SchoolUser";

/** Todos os repositórios operam sobre a BD de UM colégio (ver TenantScope). */
export interface SchoolUserRepository {
  findById(id: string): Promise<SchoolUser | null>;
  findByIdentifier(identifier: LoginIdentifier): Promise<SchoolUser | null>;
  /** Grava o agregado e os seus eventos na mesma transação. */
  save(user: SchoolUser): Promise<void>;
}

export interface SchoolSessionRepository {
  findById(id: string): Promise<SchoolSession | null>;
  save(session: SchoolSession): Promise<void>;
  /** Atualiza "visto pela última vez" sem carregar o agregado. */
  touch(id: string, now: Date): Promise<void>;
  /** Revoga todas as sessões ativas (exceto, opcionalmente, uma). Devolve quantas. */
  revokeAll(userId: string, reason: string, now: Date, exceptId?: string): Promise<number>;
}

export interface EmailCodeRepository {
  /** O código mais recente para esta finalidade (os anteriores deixam de valer). */
  latest(userId: string, purpose: EmailCodePurpose): Promise<EmailCode | null>;
  /** Histórico desde `since` (limites por conta: códigos pedidos e tentativas erradas). */
  stats(userId: string, purpose: EmailCodePurpose, since: Date): Promise<OtpStats>;
  save(code: EmailCode): Promise<void>;
}
