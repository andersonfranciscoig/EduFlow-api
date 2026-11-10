import { randomUUID } from "node:crypto";
import { PrismaClient as PlatformClient, type Prisma } from ".prisma/platform-client";
import { parsePostgresUrl, type PostgresUrl } from "../../../libs/kernel/src/domain/postgres-url";
import { openSealed, readKeyFile } from "../../../libs/kernel/src/infrastructure/keys";
import { loadEnv } from "./env";
import { type CheckResult, runCheck, type ServerKind } from "./health-check";
import { friendlyError } from "./pg-target";
import { type Job, provisionOnDedicatedDatabase, provisionOnSharedServer, type ProvisionContext } from "./provision";

/**
 * PROVISIONER — o único serviço que conhece os URLs dos servidores de BD.
 *
 * Não está exposto à internet (não abre portas). Num ciclo:
 *   1. pedidos de criação de BD (tenant_provisioning_jobs, escritos na ativação do colégio)
 *      → cria a BD no servidor ATRIBUÍDO (partilhado ou dedicado) e regista-a no diretório;
 *   2. testes de ligação pedidos pela equipa (database_server_checks);
 *   3. vigilância periódica de todos os servidores ativos (latência, versão, TLS…).
 */
const env = loadEnv();
const tenantPublicKey = readKeyFile(env.TENANT_CREDENTIALS_PUBLIC_KEY_FILE);
const serverPrivateKey = readKeyFile(env.SERVER_CREDENTIALS_PRIVATE_KEY_FILE);
const platform = new PlatformClient({ datasources: { db: { url: env.PROVISIONER_DATABASE_URL } }, log: ["warn", "error"] });

const log = (msg: string) => console.log(`[provisioner] ${new Date().toISOString()} ${msg}`);
const ctx: ProvisionContext = { platform, tenantPublicKey, log };

// ======================================================================= servidores

interface ServerRow {
  id: string;
  kind: ServerKind;
  status: "ACTIVE" | "DISABLED";
}

/** Lê o servidor (só colunas autorizadas) e abre o URL selado. */
async function loadServer(id: string): Promise<{ server: ServerRow; url: PostgresUrl }> {
  const rows = await platform.$queryRaw<(ServerRow & { url_ciphertext: string | null })[]>`
    SELECT s.id, s.kind::text AS kind, s.status::text AS status, sec.url_ciphertext
    FROM database_servers s LEFT JOIN database_server_secrets sec ON sec.server_id = s.id
    WHERE s.id = ${id}::uuid`;
  const row = rows[0];
  if (!row) throw new Error("Servidor não encontrado.");
  if (!row.url_ciphertext) throw new Error("O servidor não tem URL de ligação.");
  const parsed = parsePostgresUrl(openSealed(serverPrivateKey, row.url_ciphertext), { requireDatabase: row.kind === "DEDICATED_DATABASE" });
  if (!parsed.ok) throw new Error(parsed.error);
  return { server: { id: row.id, kind: row.kind, status: row.status }, url: parsed.value };
}

async function recordCheck(serverId: string, checkId: string, result: CheckResult) {
  const health = !result.ok ? "UNREACHABLE" : (result.latencyMs ?? 0) > env.SLOW_LATENCY_MS ? "DEGRADED" : "HEALTHY";
  await platform.databaseServerCheck.update({
    where: { id: checkId },
    data: {
      status: "DONE",
      ok: result.ok,
      connectMs: result.connectMs,
      latencyMs: result.latencyMs,
      serverVersion: result.serverVersion,
      tls: result.tls,
      details: result.details as Prisma.InputJsonValue,
      error: result.error,
      completedAt: new Date(),
    },
  });
  // UPDATE sem RETURNING: o provisioner só pode escrever as colunas de saúde
  await platform.$executeRaw`
    UPDATE database_servers SET
      health = ${health}::"DatabaseServerHealth",
      last_checked_at = now(),
      last_latency_ms = ${result.latencyMs},
      server_version = COALESCE(${result.serverVersion}, server_version),
      tls_active = COALESCE(${result.tls}, tls_active),
      last_error = ${result.error},
      consecutive_failures = CASE WHEN ${result.ok} THEN 0 ELSE consecutive_failures + 1 END,
      updated_at = now()
    WHERE id = ${serverId}::uuid`;
  return health;
}

async function check(serverId: string, checkId: string) {
  let result: CheckResult;
  try {
    const { server, url } = await loadServer(serverId);
    result = await runCheck(server.kind, url);
  } catch (error) {
    result = {
      ok: false,
      connectMs: null,
      latencyMs: null,
      serverVersion: null,
      tls: null,
      details: { errors: [String((error as Error).message ?? error)], warnings: [] },
      error: String((error as Error).message ?? error).slice(0, 500),
    };
  }
  const health = await recordCheck(serverId, checkId, result);
  log(`teste ${serverId.slice(0, 8)} → ${health}${result.latencyMs != null ? ` (${result.latencyMs} ms)` : ""}${result.error ? ` — ${result.error}` : ""}`);
}

/** Testes pedidos pela equipa. */
async function claimChecks(limit: number) {
  return platform.$queryRaw<{ id: string; server_id: string }[]>`
    UPDATE database_server_checks SET status = 'RUNNING'
    WHERE id IN (
      SELECT id FROM database_server_checks WHERE status = 'PENDING'
      ORDER BY created_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, server_id`;
}

/** Os testes correm em paralelo: um servidor que não responde não atrasa os outros. */
const runChecks = (list: { id: string; server_id: string }[]) =>
  Promise.allSettled(list.map((c) => check(c.server_id, c.id))).then((results) => {
    for (const r of results) if (r.status === "rejected") log(`✗ teste de ligação: ${describe(r.reason)}`);
  });

let lastSweep = 0;
let sweeping: Promise<void> | null = null;
/** Vigilância periódica — em segundo plano, sem bloquear a criação de BDs. */
function periodicChecks() {
  if (sweeping || Date.now() - lastSweep < env.HEALTH_CHECK_INTERVAL_MS) return;
  lastSweep = Date.now();
  sweeping = (async () => {
    const servers = await platform.$queryRaw<{ id: string }[]>`SELECT id FROM database_servers WHERE status = 'ACTIVE'`;
    const list = servers.map((s) => ({ id: randomUUID(), server_id: s.id }));
    if (list.length) {
      await platform.databaseServerCheck.createMany({ data: list.map((c) => ({ id: c.id, serverId: c.server_id, kind: "PERIODIC", status: "RUNNING" })) });
      await runChecks(list);
    }
    // histórico: 7 dias de testes periódicos
    await platform.$executeRaw`DELETE FROM database_server_checks WHERE kind = 'PERIODIC' AND created_at < now() - interval '7 days'`;
  })()
    .catch((error) => log(`✗ vigilância: ${describe(error)}`))
    .finally(() => {
      sweeping = null;
    });
}

function describe(error: unknown) {
  const e = error as { code?: string; message?: string };
  return `${e.code ? `[${e.code}] ` : ""}${e.message || String(error)}`.slice(0, 500);
}

// ======================================================================= criação das BDs

async function claimJob(): Promise<Job | null> {
  const rows = await platform.$queryRaw<Job[]>`
    UPDATE tenant_provisioning_jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM tenant_provisioning_jobs
      WHERE (status = 'PENDING'
             OR (status = 'FAILED' AND attempts < ${env.MAX_ATTEMPTS} AND updated_at < now() - interval '30 seconds'))
        AND (server_id IS NOT NULL OR ${env.LOCAL_FALLBACK_SERVER})
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, school_id, slug, school_name, owner_name, owner_email, attempts, server_id`;
  return rows[0] ?? null;
}

/** Desenvolvimento: o próprio cluster local (como antes da fase 3). */
function localServer(): PostgresUrl {
  const parsed = parsePostgresUrl(env.PROVISIONER_DATABASE_URL.replace(/\?.*$/, ""));
  if (!parsed.ok) throw new Error(`PROVISIONER_DATABASE_URL inválido: ${parsed.error}`);
  return parsed.value;
}

async function provision(job: Job) {
  if (!job.server_id) {
    log(`${job.slug}: sem servidor atribuído → cluster local (LOCAL_FALLBACK_SERVER)`);
    await provisionOnSharedServer(job, localServer(), { host: env.TENANT_DB_HOST, port: env.TENANT_DB_PORT, sslMode: "disable", serverId: null }, ctx);
  } else {
    const { server, url } = await loadServer(job.server_id);
    if (server.kind === "SHARED_SERVER") {
      await provisionOnSharedServer(job, url, { host: url.host, port: url.port, sslMode: url.sslMode, serverId: server.id }, ctx);
    } else {
      await provisionOnDedicatedDatabase(job, url, server.id, ctx);
    }
  }
  // provisioned_at: a 1.ª vez fica registada (depois disto, voltar a PENDING só atualiza)
  await platform.$executeRaw`
    UPDATE tenant_provisioning_jobs
    SET status = 'DONE', last_error = NULL, provisioned_at = COALESCE(provisioned_at, now()), updated_at = now()
    WHERE id = ${job.id}::uuid`;
}

// ======================================================================= ciclo

let running = true;
async function loop() {
  log(`a vigiar a fila (cada ${env.POLL_INTERVAL_MS} ms; saúde dos servidores cada ${Math.round(env.HEALTH_CHECK_INTERVAL_MS / 1000)} s)`);
  if (env.LOCAL_FALLBACK_SERVER) log("aviso: LOCAL_FALLBACK_SERVER ativo (só desenvolvimento)");
  // testes interrompidos (ex.: o provisioner foi reiniciado a meio) voltam à fila
  await platform.$executeRaw`
    UPDATE database_server_checks SET status = 'PENDING'
    WHERE status = 'RUNNING' AND kind <> 'PERIODIC' AND created_at < now() - interval '2 minutes'`;
  await platform.$executeRaw`
    UPDATE database_server_checks SET status = 'DONE', ok = false, error = 'Teste interrompido', completed_at = now()
    WHERE status = 'RUNNING' AND kind = 'PERIODIC' AND created_at < now() - interval '2 minutes'`;
  while (running) {
    let worked = false;

    let job: Job | null = null;
    try {
      job = await claimJob();
      if (job) {
        worked = true;
        await provision(job);
      }
    } catch (error) {
      const message = friendlyError(error);
      log(`✗ ${job?.slug ?? "?"}: ${message}`);
      if (job) {
        await platform.tenantProvisioningJob
          .update({ where: { id: job.id }, data: { status: "FAILED", lastError: message.slice(0, 1000) } })
          .catch(() => undefined);
      }
    }

    try {
      // em segundo plano: um teste lento não atrasa a criação das BDs
      const pending = await claimChecks(5);
      if (pending.length) void runChecks(pending);
      periodicChecks();
    } catch (error) {
      log(`✗ testes de ligação: ${describe(error)}`);
    }

    if (!worked) await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_MS));
  }
  await platform.$disconnect();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("a terminar…");
    running = false;
  });
}

void loop();
