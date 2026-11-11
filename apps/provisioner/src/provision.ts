import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import type { PrismaClient as PlatformClient } from ".prisma/platform-client";
import type { PostgresUrl, SslMode } from "../../../libs/kernel/src/domain/postgres-url";
import { encryptSecret } from "../../../libs/kernel/src/infrastructure/keys";
import { pgClient } from "./pg-target";
import { migrateTenant, seedTenant } from "./tenant-migrator";

export interface Job {
  id: string;
  school_id: string;
  slug: string;
  school_name: string;
  owner_name: string | null;
  owner_email: string | null;
  attempts: number;
  server_id: string | null;
}

export interface ProvisionContext {
  platform: PlatformClient;
  tenantPublicKey: string;
  log: (msg: string) => void;
}

/** Onde o colégio vai ligar-se (gravado no diretório lido pelo school-api). */
interface Placement {
  host: string;
  port: number;
  sslMode: SslMode;
  serverId: string | null;
}

/** Migrações + identidade + conta do responsável, com um cliente já "como o colégio". */
async function migrateAndSeed(db: Client, job: Job, ctx: ProvisionContext) {
  const applied = await migrateTenant(db);
  if (applied.length) ctx.log(`${job.slug}: migrações aplicadas → ${applied.join(", ")}`);
  await seedTenant(db, job, ctx.log);
}

async function register(job: Job, at: Placement, db: { name: string; user: string; password: string }, ctx: ProvisionContext) {
  const directory = {
    slug: job.slug,
    schoolName: job.school_name,
    dbHost: at.host,
    dbPort: at.port,
    dbName: db.name,
    dbUser: db.user,
    // só o school-api (chave privada) consegue decifrar
    passwordCiphertext: encryptSecret(ctx.tenantPublicKey, db.password),
    sslMode: at.sslMode,
    serverId: at.serverId,
  };
  // "active" só na criação: voltar a processar um colégio DESATIVADO (ex.: troca de email)
  // nunca pode reabrir o portal — isso é decisão da plataforma (desativar/reativar)
  await ctx.platform.tenantDatabase.upsert({
    where: { schoolId: job.school_id },
    create: { schoolId: job.school_id, ...directory, active: true },
    update: directory,
  });
}

/**
 * SERVIDOR PARTILHADO: um utilizador e uma BD próprios do colégio.
 *
 * Criação: utilizador com senha aleatória → BD (dono = colégio) → migrações →
 * senha cifrada no diretório.
 * Atualização (a BD já existe e está no diretório): SÓ migrações — a senha NÃO
 * muda, por isso o school-api não perde ligações. As migrações correm como o
 * colégio (SET ROLE) com a ligação de administração do servidor.
 *
 * O provisioner só é membro do utilizador do colégio DURANTE o trabalho e
 * retira-o a si próprio no fim (mantém só a gestão, não os dados).
 */
export async function provisionOnSharedServer(job: Job, admin: PostgresUrl, at: Placement, ctx: ProvisionContext) {
  // nomes derivados do id (sem dados pessoais) e validados — nunca vêm do utilizador
  const name = `tenant_${job.school_id.replace(/-/g, "").slice(0, 12)}`;
  if (!/^tenant_[0-9a-f]{12}$/.test(name)) throw new Error(`Nome inválido: ${name}`);

  const listed = await ctx.platform.tenantDatabase.findUnique({
    where: { schoolId: job.school_id },
    select: { dbName: true, dbHost: true, dbPort: true },
  });
  const inDirectory = listed?.dbName === name && listed.dbHost === at.host && listed.dbPort === at.port;

  const client = pgClient(admin);
  await client.connect();
  let newPassword: string | null = null;
  try {
    const version = Number((await client.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0]!.v);
    const roleExists = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [name])).rowCount;

    if (!roleExists || !inDirectory) {
      // primeira vez (ou o registo no diretório não chegou a ser feito): senha nova
      newPassword = randomBytes(24).toString("hex"); // hex: seguro dentro de '…'
      await client.query(
        roleExists
          ? `ALTER ROLE "${name}" WITH LOGIN PASSWORD '${newPassword}'`
          : `CREATE ROLE "${name}" WITH LOGIN PASSWORD '${newPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 30`,
      );
    }

    // PG16+: a pertença precisa de SET (CREATE DATABASE … OWNER e SET ROLE) — retirada no fim
    await client.query(version >= 160000 ? `GRANT "${name}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE` : `GRANT "${name}" TO CURRENT_USER`);
    try {
      const dbExists = (await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount;
      if (!dbExists) await client.query(`CREATE DATABASE "${name}" OWNER "${name}"`);
      await client.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);

      const tenantDb = pgClient(admin, name);
      await tenantDb.connect();
      try {
        await tenantDb.query(`SET ROLE "${name}"`); // tudo o que for criado fica do colégio
        await migrateAndSeed(tenantDb, job, ctx);
      } finally {
        await tenantDb.end().catch(() => undefined);
      }
    } finally {
      await client.query(`REVOKE "${name}" FROM CURRENT_USER`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  if (newPassword) {
    await register(job, at, { name, user: name, password: newPassword }, ctx);
    ctx.log(`✓ ${job.slug} → base de dados ${name} pronta em ${at.host}:${at.port}`);
  } else {
    ctx.log(`✓ ${job.slug} → base de dados ${name} atualizada (senha mantida)`);
  }
}

/**
 * BD DEDICADA: já existe e é só deste colégio. Usa as credenciais registadas
 * (tem de estar vazia ou já ser gerida pela EduFlow).
 */
export async function provisionOnDedicatedDatabase(job: Job, url: PostgresUrl, serverId: string, ctx: ProvisionContext) {
  const client = pgClient(url);
  await client.connect();
  try {
    const { rows } = await client.query<{ tables: number; managed: boolean; has_info: boolean }>(
      `SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_tenant_migrations') AS tables,
              to_regclass('public._tenant_migrations') IS NOT NULL AS managed,
              to_regclass('public.tenant_info') IS NOT NULL AS has_info`,
    );
    const r = rows[0]!;
    if (r.tables > 0 && !r.managed) throw new Error(`A base de dados dedicada não está vazia (${r.tables} tabela(s)).`);
    if (r.has_info) {
      const owner = (await client.query<{ school: string }>(`SELECT school_id::text AS school FROM tenant_info WHERE id = 1`)).rows[0];
      if (owner && owner.school !== job.school_id) throw new Error("Esta base de dados já pertence a outro colégio.");
    }
    await migrateAndSeed(client, job, ctx);
  } finally {
    await client.end().catch(() => undefined);
  }

  const at: Placement = { host: url.host, port: url.port, sslMode: url.sslMode, serverId };
  await register(job, at, { name: url.database, user: url.user, password: url.password }, ctx);
  ctx.log(`✓ ${job.slug} → base de dados dedicada ${url.database} pronta em ${url.host}:${url.port}`);
}
