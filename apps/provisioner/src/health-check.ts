import { performance } from "node:perf_hooks";
import type { PostgresUrl } from "../../../libs/kernel/src/domain/postgres-url";
import { friendlyError, pgClient } from "./pg-target";

export type ServerKind = "SHARED_SERVER" | "DEDICATED_DATABASE";

export interface CheckResult {
  ok: boolean;
  connectMs: number | null;
  latencyMs: number | null;
  serverVersion: string | null;
  tls: boolean | null;
  details: Record<string, unknown>;
  error: string | null;
}

const MIN_VERSION = 140000;

/** A ligação deste cliente está mesmo cifrada? (socket TLS) */
function isEncrypted(client: object): boolean {
  const stream = (client as { connection?: { stream?: { encrypted?: boolean } } }).connection?.stream;
  return stream?.encrypted === true;
}
const ms = (start: number) => Math.round(performance.now() - start);

/**
 * Teste de ligação feito pelo provisioner (o único que conhece o URL):
 * tempo de ligação, latência (mediana de 3 pedidos), versão, TLS e as
 * permissões necessárias para o tipo de servidor.
 */
export async function runCheck(kind: ServerKind, url: PostgresUrl): Promise<CheckResult> {
  const client = pgClient(url);
  const errors: string[] = [];
  const warnings: string[] = [];
  const details: Record<string, unknown> = {};
  let connectMs: number | null = null;
  let latencyMs: number | null = null;
  let serverVersion: string | null = null;
  let tls: boolean | null = null;

  try {
    const t0 = performance.now();
    await client.connect();
    connectMs = ms(t0);

    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await client.query("SELECT 1");
      samples.push(performance.now() - t);
    }
    latencyMs = Math.max(1, Math.round(samples.sort((a, b) => a - b)[1]!));

    const info = await client.query<{ num: string; version: string }>(
      `SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version`,
    );
    const row = info.rows[0]!;
    serverVersion = row.version.split(" ")[0] ?? row.version;
    // TLS visto do lado de quem liga (atrás de um proxy — Neon, PgBouncer… — o
    // pg_stat_ssl do servidor descreve a ligação interna, não a nossa)
    tls = isEncrypted(client);
    if (Number(row.num) < MIN_VERSION) errors.push(`É preciso PostgreSQL 14 ou superior (este servidor tem ${serverVersion}).`);
    if (!url.isLocal && !tls) errors.push("A ligação não está cifrada (TLS).");

    if (kind === "SHARED_SERVER") {
      const role = await client.query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
        `SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
      );
      const r = role.rows[0]!;
      const stats = await client.query<{ tenants: number; public_connect: boolean }>(
        `SELECT (SELECT count(*)::int FROM pg_database WHERE datname LIKE 'tenant\\_%') AS tenants,
                COALESCE((SELECT has_database_privilege('public', datname, 'CONNECT') FROM pg_database WHERE datname = 'postgres'), false) AS public_connect`,
      );
      const s = stats.rows[0]!;
      Object.assign(details, { superuser: r.rolsuper, createdb: r.rolcreatedb, createrole: r.rolcreaterole, tenantDatabases: s.tenants });
      if (!r.rolsuper && (!r.rolcreatedb || !r.rolcreaterole)) {
        errors.push("O utilizador precisa das permissões CREATEDB e CREATEROLE para criar as BDs dos colégios.");
      }
      if (r.rolsuper) warnings.push("Está a usar um superutilizador. Recomenda-se um utilizador só com CREATEDB e CREATEROLE.");
      if (s.public_connect) warnings.push('Qualquer utilizador pode ligar-se à base "postgres". Recomenda-se: REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;');
    } else {
      const db = await client.query<{ owner: boolean; can_create: boolean; tables: number; managed: boolean }>(
        `SELECT (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = current_user AS owner,
                has_schema_privilege('public', 'CREATE') AS can_create,
                (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_tenant_migrations') AS tables,
                to_regclass('public._tenant_migrations') IS NOT NULL AS managed`,
      );
      const d = db.rows[0]!;
      Object.assign(details, { owner: d.owner, canCreate: d.can_create, tables: d.tables, managedByEduFlow: d.managed });
      if (!d.can_create) errors.push('O utilizador não pode criar tabelas no esquema "public" desta base de dados.');
      if (d.tables > 0 && !d.managed) warnings.push(`A base de dados não está vazia (${d.tables} tabela(s)). Só uma BD vazia pode ser atribuída a um colégio.`);
      if (!d.owner) warnings.push("O utilizador não é o dono da base de dados.");
    }
  } catch (error) {
    errors.push(friendlyError(error));
  } finally {
    await client.end().catch(() => undefined);
  }

  return {
    ok: errors.length === 0,
    connectMs,
    latencyMs,
    serverVersion,
    tls,
    details: { ...details, errors, warnings },
    error: errors.length ? errors.join(" ") : null,
  };
}
