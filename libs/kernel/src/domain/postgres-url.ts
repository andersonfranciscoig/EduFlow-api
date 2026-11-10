/**
 * URL de ligação PostgreSQL — validação partilhada (sem dependências).
 *   postgresql://utilizador:senha@host:5432/base?sslmode=require
 *
 * Regras:
 *  - só os esquemas postgres:// e postgresql://
 *  - utilizador e senha obrigatórios
 *  - só se aceitam os parâmetros sslmode, channel_binding, connect_timeout e application_name
 *  - fora de localhost é obrigatório TLS (sslmode=require|verify-ca|verify-full)
 */
export const SSL_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;
export type SslMode = (typeof SSL_MODES)[number];

/** SCRAM ligado ao canal TLS (ex.: Neon usa channel_binding=require). */
export const CHANNEL_BINDINGS = ["disable", "prefer", "require"] as const;
export type ChannelBinding = (typeof CHANNEL_BINDINGS)[number];

export interface PostgresUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
  channelBinding: ChannelBinding;
  /** user@host:port/database — sem segredos */
  endpoint: string;
  isLocal: boolean;
}

const ALLOWED_PARAMS = new Set(["sslmode", "channel_binding", "connect_timeout", "application_name"]);

export function isLocalHost(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function parsePostgresUrl(raw: string, options: { requireDatabase?: boolean } = {}): { ok: true; value: PostgresUrl } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length > 2048) return { ok: false, error: "O URL é demasiado longo." };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "URL inválido. Formato: postgresql://utilizador:senha@servidor:5432/base" };
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    return { ok: false, error: "O URL tem de começar por postgresql://" };
  }

  const host = url.hostname;
  if (!host) return { ok: false, error: "Indique o servidor (host) no URL." };
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!user) return { ok: false, error: "Indique o utilizador no URL." };
  if (!password) return { ok: false, error: "Indique a senha no URL." };

  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Porta inválida." };

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (options.requireDatabase && !database) return { ok: false, error: "Indique o nome da base de dados no URL (…/nome_da_base)." };
  if (database.includes("/")) return { ok: false, error: "Nome da base de dados inválido." };

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return { ok: false, error: `Parâmetro "${key}" não suportado (permitidos: sslmode, channel_binding, connect_timeout, application_name).` };
    }
  }

  const bindingRaw = url.searchParams.get("channel_binding") ?? "prefer";
  if (!(CHANNEL_BINDINGS as readonly string[]).includes(bindingRaw)) {
    return { ok: false, error: "channel_binding tem de ser disable, prefer ou require." };
  }
  const channelBinding = bindingRaw as ChannelBinding;

  const isLocal = isLocalHost(host);
  const sslRaw = url.searchParams.get("sslmode") ?? (isLocal ? "disable" : "");
  // "prefer"/"allow" não garantem cifragem — não aceites
  if (!(SSL_MODES as readonly string[]).includes(sslRaw)) {
    return { ok: false, error: "Servidores remotos exigem ligação cifrada: acrescente ?sslmode=require (ou verify-full)." };
  }
  const sslMode = sslRaw as SslMode;
  if (!isLocal && sslMode === "disable") {
    return { ok: false, error: "Servidores remotos exigem ligação cifrada (TLS): use sslmode=require ou verify-full." };
  }
  if (channelBinding === "require" && sslMode === "disable") {
    return { ok: false, error: "channel_binding=require precisa de TLS (sslmode=require ou superior)." };
  }

  const db = database || "postgres";
  return {
    ok: true,
    value: { host, port, database: db, user, password, sslMode, channelBinding, endpoint: `${user}@${host}:${port}/${db}`, isLocal },
  };
}
