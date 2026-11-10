import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";

const MIGRATIONS_DIR = path.resolve("prisma/tenant/migrations");

/**
 * Aplica as migrações de prisma/tenant/migrations que ainda faltam na BD do
 * colégio, cada uma numa transação. Os objetos ficam do utilizador do colégio:
 * o cliente já está ligado como ele (BD dedicada) ou fez SET ROLE para ele.
 */
export async function migrateTenant(db: Client): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS "_tenant_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );
  const applied = new Set((await db.query<{ name: string }>(`SELECT "name" FROM "_tenant_migrations"`)).rows.map((r) => r.name));

  const pending = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !applied.has(d.name))
    .map((d) => d.name)
    .sort();

  for (const name of pending) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql); // protocolo simples: várias instruções numa só chamada
      await db.query(`INSERT INTO "_tenant_migrations" ("name") VALUES ($1)`, [name]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migração ${name}: ${(error as Error).message}`);
    }
  }
  return pending;
}

/**
 * Identidade do colégio na sua BD + conta do responsável (DIRETOR), criada
 * só da primeira vez, POR ATIVAR e sem senha: ele ativa-a no portal com um
 * código enviado para o seu email. O provisioner nunca gera credenciais de pessoas.
 */
export async function seedTenant(
  db: Client,
  job: { school_id: string; slug: string; school_name: string; owner_name: string | null; owner_email: string | null },
  log: (msg: string) => void,
) {
  await db.query(
    `INSERT INTO tenant_info (id, school_id, slug, name) VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name`,
    [job.school_id, job.slug, job.school_name],
  );

  const email = job.owner_email?.trim().toLowerCase();
  const name = job.owner_name?.trim();
  if (!email || !name) return log(`${job.slug}: pedido sem responsável — conta não criada`);
  const owner = await db.query<{ email: string | null; status: string }>(`SELECT email, status FROM school_users WHERE is_owner LIMIT 1`);
  if (owner.rowCount) {
    // o responsável mudou de email na plataforma e ainda não ativou o portal → acompanha
    const current = owner.rows[0]!;
    if (current.status === "INVITED" && current.email !== email) {
      await db.query(`UPDATE school_users SET email = $1, full_name = $2, updated_at = now() WHERE is_owner AND status = 'INVITED'`, [email, name]);
      log(`${job.slug}: email do responsável atualizado (conta por ativar)`);
    }
    return;
  }
  const inserted = await db.query(
    `INSERT INTO school_users (id, full_name, email, role, status, is_owner, updated_at)
     VALUES ($1, $2, $3, 'DIRETOR', 'INVITED', true, now()) ON CONFLICT DO NOTHING`,
    [randomUUID(), name, email],
  );
  if (inserted.rowCount) log(`${job.slug}: conta do responsável criada (por ativar)`);
}
