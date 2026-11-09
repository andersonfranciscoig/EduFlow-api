import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient as TenantClient } from ".prisma/tenant-client";

const MIGRATIONS_DIR = path.resolve("prisma/tenant/migrations");

/** Divide um ficheiro de migração em instruções (o Prisma só executa uma de cada vez). */
function statements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Aplica as migrações de prisma/tenant/migrations que ainda faltam na base de
 * dados do colégio. Corre com o utilizador do PRÓPRIO colégio (dono da BD).
 */
export async function migrateTenant(db: TenantClient): Promise<string[]> {
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "_tenant_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );
  const applied = new Set(
    (await db.$queryRawUnsafe<{ name: string }[]>(`SELECT "name" FROM "_tenant_migrations"`)).map((r) => r.name),
  );

  const pending = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !applied.has(d.name))
    .map((d) => d.name)
    .sort();

  for (const name of pending) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
    await db.$transaction([
      ...statements(sql).map((s) => db.$executeRawUnsafe(s)),
      db.$executeRawUnsafe(`INSERT INTO "_tenant_migrations" ("name") VALUES ($1)`, name),
    ]);
  }
  return pending;
}
