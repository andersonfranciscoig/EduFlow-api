import { Client, type ClientConfig } from "pg";
import type { PostgresUrl, SslMode } from "../../../libs/kernel/src/domain/postgres-url";

/** TLS ao estilo libpq (sem os atalhos do pg-connection-string). */
export function sslOption(mode: SslMode): ClientConfig["ssl"] {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return { rejectUnauthorized: true };
  }
}

export function pgClient(url: PostgresUrl, database = url.database) {
  return new Client({
    host: url.host,
    port: url.port,
    user: url.user,
    password: url.password,
    database,
    ssl: sslOption(url.sslMode),
    // SCRAM-SHA-256-PLUS quando o servidor o oferece (Neon, RDS…); exige TLS
    enableChannelBinding: url.sslMode !== "disable" && url.channelBinding !== "disable",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    application_name: "eduflow-provisioner",
  });
}

/** URL para o Prisma (migrações do colégio). */
export function prismaUrl(target: { host: string; port: number; sslMode: SslMode }, user: string, password: string, database: string) {
  const ssl =
    target.sslMode === "disable"
      ? "sslmode=disable"
      : target.sslMode === "require"
        ? "sslmode=require&sslaccept=accept_invalid_certs"
        : "sslmode=require&sslaccept=strict";
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${target.port}/${encodeURIComponent(database)}?schema=public&connection_limit=2&${ssl}`;
}

/** Mensagem compreensível para os erros de ligação mais comuns (nunca inclui a senha). */
export function friendlyError(error: unknown): string {
  const e = error as { code?: string; message?: string };
  switch (e.code) {
    case "ECONNREFUSED":
      return "Ligação recusada: o servidor não está a aceitar ligações nessa porta.";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Servidor não encontrado (DNS): confirme o endereço.";
    case "ETIMEDOUT":
    case "ECONNRESET":
      return "Sem resposta do servidor (firewall ou rede).";
    case "28P01":
    case "28000":
      return "Autenticação falhou: utilizador ou senha errados (ou sem permissão para este IP).";
    case "3D000":
      return "A base de dados indicada não existe.";
    case "53300":
      return "O servidor atingiu o limite de ligações.";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "O certificado TLS do servidor não é de confiança (use sslmode=require ou um certificado válido).";
  }
  const message = e.message ?? String(error);
  if (/timeout/i.test(message)) return "Sem resposta do servidor dentro do tempo limite.";
  if (/does not support SSL|SSL off/i.test(message)) return "O servidor não suporta TLS.";
  return message.slice(0, 300);
}
