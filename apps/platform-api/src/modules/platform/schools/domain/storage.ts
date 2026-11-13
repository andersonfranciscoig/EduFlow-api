import { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";

/**
 * ARMAZENAMENTO DE FICHEIROS DE CADA COLÉGIO — a sua própria app do UploadThing.
 * A equipa cola o token da app (copiado do painel do UploadThing: API Keys → V7);
 * daqui sai o id da app (público) e uma pista da chave, nunca o token.
 */
export type StorageErrorCode = "SCHOOL_NOT_FOUND" | "INVALID_TOKEN" | "TOKEN_REJECTED" | "APP_IN_USE" | "NOT_CONFIGURED" | "KEY_MISSING" | "STORAGE_UNAVAILABLE";
export type StorageError = DomainError<StorageErrorCode>;
export const storageError = (code: StorageErrorCode, message: string) => new DomainError(code, message);

export type StoragePlan = "FREE" | "PAID" | "UNKNOWN";
export const PLAN_LABELS: Record<StoragePlan, string> = { FREE: "Grátis", PAID: "Pago", UNKNOWN: "Por confirmar" };

/** O plano grátis do UploadThing tem 2 GB; acima disso é um plano pago. */
const FREE_LIMIT = 2 * 1024 ** 3;
export const planFromLimit = (limitBytes: number | null | undefined): StoragePlan => (limitBytes == null ? "UNKNOWN" : limitBytes <= FREE_LIMIT * 1.05 ? "FREE" : "PAID");

export interface ParsedToken {
  token: string;
  appId: string;
  keyHint: string;
}

/**
 * Token V7 do UploadThing: base64 de { apiKey: "sk_…", appId, regions }.
 * Aceita-o com espaços ou aspas à volta (colado de um .env).
 */
export function parseUploadThingToken(raw: string): Result<ParsedToken, StorageError> {
  const token = raw
    .trim()
    .replace(/^UPLOADTHING_TOKEN\s*=\s*/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  const invalid = () => fail(storageError("INVALID_TOKEN", "Isto não é um token do UploadThing. Copie-o em API Keys → V7 (começa normalmente por “eyJ”)."));
  if (token.length < 40 || token.length > 4000 || !/^[A-Za-z0-9+/=_-]+$/.test(token)) return invalid();
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return invalid();
  }
  const d = data as { apiKey?: unknown; appId?: unknown };
  if (typeof d.apiKey !== "string" || !d.apiKey.startsWith("sk_") || typeof d.appId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(d.appId)) return invalid();
  return ok({ token, appId: d.appId, keyHint: `${d.apiKey.slice(0, 8)}…${d.apiKey.slice(-4)}` });
}
