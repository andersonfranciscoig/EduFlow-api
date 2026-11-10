import type { SslMode } from "../domain/postgres-url";

const SSL_MODES: readonly SslMode[] = ["disable", "require", "verify-ca", "verify-full"];

export const isSslMode = (value: string): value is SslMode => (SSL_MODES as readonly string[]).includes(value);

/**
 * URL do Prisma para a BD de um colégio — usado pelo provisioner (migrações) e
 * pelo school-api (pedidos). Tudo o que vem do diretório é codificado, e o TLS
 * segue o modo registado para o servidor (nunca é desligado em silêncio).
 */
export function tenantPrismaUrl(
  target: { host: string; port: number; sslMode: SslMode },
  credentials: { user: string; password: string; database: string },
  connectionLimit = 2,
) {
  const ssl =
    target.sslMode === "disable"
      ? "sslmode=disable"
      : target.sslMode === "require"
        ? "sslmode=require&sslaccept=accept_invalid_certs"
        : "sslmode=require&sslaccept=strict";
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  const user = encodeURIComponent(credentials.user);
  const password = encodeURIComponent(credentials.password);
  const database = encodeURIComponent(credentials.database);
  return `postgresql://${user}:${password}@${host}:${target.port}/${database}?schema=public&connection_limit=${connectionLimit}&${ssl}`;
}
