import type { PrismaClient as PlatformClient } from ".prisma/platform-client";
import { BACKUP_POLICY } from "../../../libs/kernel/src/domain/backup-policy";
import type { PostgresUrl } from "../../../libs/kernel/src/domain/postgres-url";
import { encryptBackup, sha256 } from "../../../libs/kernel/src/infrastructure/backup-crypto";
import type { BackupStore } from "./backup-store";
import { pgClient } from "./pg-target";
import { pgDump } from "./pg-dump";
import { migrateTenant } from "./tenant-migrator";

export interface Target {
  kind: "SHARED_SERVER" | "DEDICATED_DATABASE";
  url: PostgresUrl;
}

export interface MaintenanceContext {
  platform: PlatformClient;
  store: BackupStore;
  backupKey: Buffer;
  dockerImage?: string;
  log: (msg: string) => void;
  /** Ligação ao servidor do colégio (null = cluster local de desenvolvimento). */
  resolve(serverId: string | null): Promise<Target>;
}

interface TenantRow {
  school_id: string;
  slug: string;
  db_name: string;
  server_id: string | null;
}

const VALID_ROLE = /^tenant_[0-9a-f]{12}$/;

/**
 * Servidor partilhado: o provisioner só tem acesso aos dados de um colégio
 * DURANTE a operação — torna-se membro do utilizador do colégio e retira-se no fim.
 */
export async function withTenantAccess<T>(admin: PostgresUrl, role: string, fn: (client: ReturnType<typeof pgClient>) => Promise<T>): Promise<T> {
  if (!VALID_ROLE.test(role)) throw new Error(`Utilizador inválido: ${role}`);
  const client = pgClient(admin);
  await client.connect();
  try {
    const version = Number((await client.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0]!.v);
    await client.query(version >= 160000 ? `GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE` : `GRANT "${role}" TO CURRENT_USER`);
    try {
      return await fn(client);
    } finally {
      await client.query(`REVOKE "${role}" FROM CURRENT_USER`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function databaseSize(client: ReturnType<typeof pgClient>, database: string) {
  const { rows } = await client.query<{ size: string }>(`SELECT pg_database_size($1)::text AS size`, [database]);
  return BigInt(rows[0]!.size);
}

export async function tenants(platform: PlatformClient, schoolId?: string): Promise<TenantRow[]> {
  return schoolId
    ? platform.$queryRaw<TenantRow[]>`SELECT school_id::text, slug, db_name, server_id::text FROM tenant_databases WHERE school_id = ${schoolId}::uuid`
    : platform.$queryRaw<TenantRow[]>`SELECT school_id::text, slug, db_name, server_id::text FROM tenant_databases ORDER BY server_id NULLS FIRST`;
}

// ======================================================================= cópias

export async function claimBackup(platform: PlatformClient) {
  const rows = await platform.$queryRaw<{ id: string; school_id: string }[]>`
    UPDATE database_backups SET status = 'RUNNING', started_at = now()
    WHERE id = (SELECT id FROM database_backups WHERE status = 'PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id::text, school_id::text`;
  return rows[0] ?? null;
}

/** pg_dump → cifra (AES-256-GCM) → armazenamento. Só bytes cifrados saem do provisioner. */
export async function runBackup(ctx: MaintenanceContext, job: { id: string; school_id: string }) {
  try {
    const [tenant] = await tenants(ctx.platform, job.school_id);
    if (!tenant) throw new Error("A base de dados deste colégio ainda não existe.");
    const target = await ctx.resolve(tenant.server_id);

    let dump: Buffer;
    let size: bigint;
    if (target.kind === "DEDICATED_DATABASE") {
      const client = pgClient(target.url);
      await client.connect();
      try {
        size = await databaseSize(client, target.url.database);
      } finally {
        await client.end().catch(() => undefined);
      }
      dump = await pgDump({ url: target.url, database: target.url.database, dockerImage: ctx.dockerImage });
    } else {
      [size, dump] = await withTenantAccess(target.url, tenant.db_name, async (client) => [
        await databaseSize(client, tenant.db_name),
        await pgDump({ url: target.url, database: tenant.db_name, role: tenant.db_name, dockerImage: ctx.dockerImage }),
      ]);
    }

    const sealed = encryptBackup(dump, ctx.backupKey);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    const stored = await ctx.store.upload(`eduflow-backup_${tenant.slug}_${stamp}.dump.enc`, sealed);

    await ctx.platform.$executeRaw`
      UPDATE database_backups SET status = 'DONE', storage_key = ${stored.key}, size_bytes = ${BigInt(stored.size)}, database_bytes = ${size},
        sha256 = ${sha256(sealed)}, server_id = ${tenant.server_id}::uuid, error = NULL, completed_at = now()
      WHERE id = ${job.id}::uuid`;
    await ctx.platform.$executeRaw`UPDATE tenant_databases SET size_bytes = ${size}, size_measured_at = now() WHERE school_id = ${job.school_id}::uuid`;
    ctx.log(`✓ cópia de ${tenant.slug}: ${kb(dump.length)} (cifrada ${kb(sealed.length)}) → ${ctx.store.name}`);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await ctx.platform.$executeRaw`UPDATE database_backups SET status = 'FAILED', error = ${message}, completed_at = now() WHERE id = ${job.id}::uuid`;
    ctx.log(`✗ cópia ${job.school_id.slice(0, 8)}: ${message}`);
  }
}

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ======================================================================= manutenção periódica

/** Quantidade de dados de cada BD de colégio + total por servidor. */
export async function measureSizes(ctx: MaintenanceContext) {
  const rows = await tenants(ctx.platform);
  const byServer = new Map<string | null, TenantRow[]>();
  for (const r of rows) byServer.set(r.server_id, [...(byServer.get(r.server_id) ?? []), r]);

  for (const [serverId, list] of byServer) {
    try {
      const target = await ctx.resolve(serverId);
      let total = 0n;
      for (const tenant of list) {
        let size: bigint;
        if (target.kind === "DEDICATED_DATABASE") {
          const client = pgClient(target.url);
          await client.connect();
          try {
            size = await databaseSize(client, target.url.database);
          } finally {
            await client.end().catch(() => undefined);
          }
        } else {
          size = await withTenantAccess(target.url, tenant.db_name, (client) => databaseSize(client, tenant.db_name));
        }
        total += size;
        await ctx.platform.$executeRaw`UPDATE tenant_databases SET size_bytes = ${size}, size_measured_at = now() WHERE school_id = ${tenant.school_id}::uuid`;
      }
      if (serverId) await ctx.platform.$executeRaw`UPDATE database_servers SET used_bytes = ${total}, updated_at = now() WHERE id = ${serverId}::uuid`;
    } catch (error) {
      ctx.log(`✗ tamanho das BDs (${serverId?.slice(0, 8) ?? "local"}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Migrações em falta em TODOS os colégios (corre no arranque do provisioner):
 * uma versão nova pode trazer tabelas novas na BD de cada colégio.
 * Só migrações — não mexe em senhas, no diretório nem nos dados.
 */
export async function migrateAllTenants(ctx: MaintenanceContext) {
  let updated = 0;
  for (const tenant of await tenants(ctx.platform)) {
    try {
      const target = await ctx.resolve(tenant.server_id);
      const run = async (url: PostgresUrl, database: string, role?: string) => {
        const db = pgClient(url, database);
        await db.connect();
        try {
          if (role) await db.query(`SET ROLE "${role}"`);
          const applied = await migrateTenant(db);
          if (applied.length) {
            updated++;
            ctx.log(`${tenant.slug}: migrações aplicadas → ${applied.join(", ")}`);
          }
        } finally {
          await db.end().catch(() => undefined);
        }
      };
      if (target.kind === "DEDICATED_DATABASE") await run(target.url, target.url.database);
      else await withTenantAccess(target.url, tenant.db_name, () => run(target.url, tenant.db_name, tenant.db_name));
    } catch (error) {
      ctx.log(`✗ migrações de ${tenant.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return updated;
}

/** Agenda a cópia automática de cada colégio sem cópia nas últimas EVERY_HOURS horas. */
export async function scheduleAutomaticBackups(ctx: MaintenanceContext) {
  const hours = BACKUP_POLICY.EVERY_HOURS;
  const created = await ctx.platform.$executeRaw`
    INSERT INTO database_backups (id, school_id, server_id, trigger, status, created_at)
    SELECT gen_random_uuid(), td.school_id, td.server_id, 'AUTOMATIC', 'PENDING', now()
    FROM tenant_databases td
    WHERE NOT EXISTS (
      SELECT 1 FROM database_backups b
      WHERE b.school_id = td.school_id
        AND (b.status IN ('PENDING', 'RUNNING') OR (b.status = 'DONE' AND b.created_at > now() - make_interval(hours => ${hours}::int)))
    )`;
  if (created) ctx.log(`${created} cópia(s) automática(s) agendada(s)`);
}

/** Retenção: apaga do armazenamento as cópias com mais de RETENTION_DAYS dias. */
export async function applyRetention(ctx: MaintenanceContext) {
  // cópias interrompidas (o provisioner reiniciou a meio)
  await ctx.platform.$executeRaw`
    UPDATE database_backups SET status = 'FAILED', error = 'Cópia interrompida', completed_at = now()
    WHERE status = 'RUNNING' AND started_at < now() - interval '2 hours'`;

  const old = await ctx.platform.$queryRaw<{ id: string; storage_key: string }[]>`
    SELECT id::text, storage_key FROM database_backups
    WHERE status = 'DONE' AND storage_key IS NOT NULL AND completed_at < now() - make_interval(days => ${BACKUP_POLICY.RETENTION_DAYS}::int)
    LIMIT 200`;
  if (!old.length) return;
  await ctx.store.delete(old.map((o) => o.storage_key));
  await ctx.platform.$executeRaw`UPDATE database_backups SET status = 'DELETED' WHERE id = ANY(${old.map((o) => o.id)}::uuid[])`;
  ctx.log(`${old.length} cópia(s) antiga(s) apagada(s) (retenção de ${BACKUP_POLICY.RETENTION_DAYS} dias)`);
}
