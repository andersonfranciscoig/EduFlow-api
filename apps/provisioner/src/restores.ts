import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { decryptBackup, encryptBackup, sha256 } from "../../../libs/kernel/src/infrastructure/backup-crypto";
import { type MaintenanceContext, tenants, withTenantAccess } from "./backups";
import { pgClient } from "./pg-target";
import { pgDump, pgRestore, pgRestoreList } from "./pg-dump";
import { migrateTenant } from "./tenant-migrator";

/** Onde fica o estado anterior DURANTE o restauro (para voltar atrás num instante). */
const PREVIOUS = "eduflow_pre_restore";

interface RestoreJob {
  id: string;
  school_id: string;
  backup_id: string;
}

export async function claimRestore(ctx: MaintenanceContext): Promise<RestoreJob | null> {
  const rows = await ctx.platform.$queryRaw<RestoreJob[]>`
    UPDATE database_restores SET status = 'RUNNING', started_at = now()
    WHERE id = (SELECT id FROM database_restores WHERE status = 'PENDING' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id::text, school_id::text, backup_id::text`;
  return rows[0] ?? null;
}

/**
 * Restaura uma cópia na BD do colégio a que ela pertence:
 *
 *   1. descarrega, confirma o sha256 e decifra (a cópia tem de ser DESTE colégio);
 *   2. cópia de segurança do estado ATUAL (fica na lista, "Antes de restaurar");
 *   3. termina as ligações à BD e põe o schema atual de lado (rename — instantâneo);
 *   4. pg_restore numa só transação;
 *   5. confere que a BD restaurada é deste colégio → apaga o estado anterior;
 *      se algo falhar → apaga o que entrou e repõe o estado anterior;
 *   6. termina todas as sessões do portal e invalida códigos por email
 *      (a cópia traria de volta sessões antigas) e aplica as migrações em falta.
 */
export async function runRestore(ctx: MaintenanceContext, job: RestoreJob) {
  let safetyBackupId: string | null = null;
  let rolledBack = false;
  try {
    const [backup] = await ctx.platform.$queryRaw<{ storage_key: string | null; sha256: string | null; status: string; school_id: string }[]>`
      SELECT storage_key, sha256, status::text, school_id::text FROM database_backups WHERE id = ${job.backup_id}::uuid`;
    if (!backup || backup.status !== "DONE" || !backup.storage_key || !backup.sha256) throw new Error("A cópia escolhida já não está disponível.");
    if (backup.school_id !== job.school_id) throw new Error("A cópia não é deste colégio."); // a BD também o garante (FK composta)

    const [tenant] = await tenants(ctx.platform, job.school_id);
    if (!tenant) throw new Error("A base de dados deste colégio não existe.");
    const target = await ctx.resolve(tenant.server_id);

    const sealed = await ctx.store.download(backup.storage_key);
    if (sha256(sealed) !== backup.sha256) throw new Error("A cópia está corrompida (sha256 não confere).");
    const dump = decryptBackup(sealed, ctx.backupKey);
    const toc = await pgRestoreList(dump, ctx.dockerImage);
    if (!/TABLE DATA public tenant_info /.test(toc)) throw new Error("A cópia não parece ser de uma base de dados de colégio.");

    // dedicada: as credenciais registadas; partilhada: acesso temporário ao utilizador do colégio
    const shared = target.kind === "SHARED_SERVER";
    const database = shared ? tenant.db_name : target.url.database;
    const role = shared ? tenant.db_name : undefined;

    const work = async () => {
      // ---------------------------------------------------------------- 2. estado atual
      const current = await pgDump({ url: target.url, database, role, dockerImage: ctx.dockerImage });
      const currentSealed = encryptBackup(current, ctx.backupKey);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
      const stored = await ctx.store.upload(`eduflow-backup_${tenant.slug}_${stamp}_antes-de-restaurar.dump.enc`, currentSealed);
      safetyBackupId = randomUUID();

      const db = pgClient(target.url, database);
      await db.connect();
      try {
        if (role) await db.query(`SET ROLE "${role}"`);
        const size = BigInt((await db.query<{ s: string }>(`SELECT pg_database_size(current_database())::text AS s`)).rows[0]!.s);
        await ctx.platform.$executeRaw`
          INSERT INTO database_backups (id, school_id, server_id, trigger, status, requested_by_id, storage_key, size_bytes, database_bytes, sha256, created_at, started_at, completed_at)
          SELECT ${safetyBackupId}::uuid, ${job.school_id}::uuid, ${tenant.server_id}::uuid, 'PRE_RESTORE', 'DONE', r.requested_by_id,
                 ${stored.key}, ${BigInt(stored.size)}, ${size}, ${sha256(currentSealed)}, now(), now(), now()
          FROM database_restores r WHERE r.id = ${job.id}::uuid`;
        await ctx.platform.$executeRaw`UPDATE database_restores SET safety_backup_id = ${safetyBackupId}::uuid WHERE id = ${job.id}::uuid`;

        // ---------------------------------------------------------------- 3. pôr o atual de lado
        const leftover = await db.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [PREVIOUS]);
        if (leftover.rowCount) throw new Error(`Há um restauro anterior interrompido (schema ${PREVIOUS}). É preciso verificar à mão.`);
        await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
        await db.query(`ALTER SCHEMA public RENAME TO ${PREVIOUS}`);
        // o pg_restore nunca cria o "public" (assume que já existe): cria-se sempre aqui, do colégio
        await db.query(`CREATE SCHEMA public`);

        // ---------------------------------------------------------------- 4–5. restaurar
        try {
          await pgRestore({ url: target.url, database, role, dockerImage: ctx.dockerImage, dump });
          const owner = (await db.query<{ school: string }>(`SELECT school_id::text AS school FROM public.tenant_info WHERE id = 1`)).rows[0];
          if (owner?.school !== job.school_id) throw new Error("A BD restaurada não pertence a este colégio.");
        } catch (error) {
          await rollback(db);
          rolledBack = true;
          throw error;
        }
        await db.query(`DROP SCHEMA ${PREVIOUS} CASCADE`);

        // ---------------------------------------------------------------- 6. sessões, códigos, migrações
        await db.query(`SET search_path TO public`);
        if ((await db.query(`SELECT to_regclass('public.school_sessions') AS t`)).rows[0]?.t) {
          await db.query(`UPDATE school_sessions SET revoked_at = now(), revoked_reason = 'Base de dados restaurada' WHERE revoked_at IS NULL`);
        }
        if ((await db.query(`SELECT to_regclass('public.email_codes') AS t`)).rows[0]?.t) {
          await db.query(`UPDATE email_codes SET consumed_at = now() WHERE consumed_at IS NULL`);
        }
        const applied = await migrateTenant(db);
        if (applied.length) ctx.log(`${tenant.slug}: migrações aplicadas depois do restauro → ${applied.join(", ")}`);
        await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
        return BigInt((await db.query<{ s: string }>(`SELECT pg_database_size(current_database())::text AS s`)).rows[0]!.s);
      } finally {
        await db.end().catch(() => undefined);
      }
    };

    const size = shared ? await withTenantAccess(target.url, tenant.db_name, () => work()) : await work();

    await ctx.platform.$executeRaw`UPDATE database_restores SET status = 'DONE', error = NULL, completed_at = now() WHERE id = ${job.id}::uuid`;
    await ctx.platform.$executeRaw`UPDATE tenant_databases SET size_bytes = ${size}, size_measured_at = now() WHERE school_id = ${job.school_id}::uuid`;
    ctx.log(`✓ restauro de ${tenant.slug} concluído (cópia ${job.backup_id.slice(0, 8)}; estado anterior guardado na cópia ${String(safetyBackupId).slice(0, 8)})`);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await ctx.platform.$executeRaw`
      UPDATE database_restores SET status = 'FAILED', error = ${message}, rolled_back = ${rolledBack}, completed_at = now() WHERE id = ${job.id}::uuid`;
    ctx.log(`✗ restauro ${job.school_id.slice(0, 8)}: ${message}${rolledBack ? " (estado anterior reposto)" : ""}`);
  }
}

/** Apaga o que o pg_restore deixou e repõe o schema anterior. */
async function rollback(db: Client) {
  await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
  await db.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.query(`ALTER SCHEMA ${PREVIOUS} RENAME TO public`);
}

/** Restauros interrompidos (o provisioner reiniciou a meio) — ficam para verificação, nunca se repetem sozinhos. */
export async function failInterruptedRestores(ctx: MaintenanceContext) {
  await ctx.platform.$executeRaw`
    UPDATE database_restores SET status = 'FAILED', error = 'Restauro interrompido (o serviço reiniciou). Verifique a BD antes de tentar de novo.', completed_at = now()
    WHERE status = 'RUNNING' AND started_at < now() - interval '2 hours'`;
}
