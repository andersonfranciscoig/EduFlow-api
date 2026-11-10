import { randomBytes } from "node:crypto";
import type { PrismaClient as PlatformClient } from ".prisma/platform-client";
import { PrismaClient as TenantClient } from ".prisma/tenant-client";
import type { PostgresUrl, SslMode } from "../../../libs/kernel/src/domain/postgres-url";
import { encryptSecret } from "../../../libs/kernel/src/infrastructure/keys";
import { pgClient, prismaUrl } from "./pg-target";
import { migrateTenant } from "./tenant-migrator";

export interface Job {
  id: string;
  school_id: string;
  slug: string;
  school_name: string;
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

/** Migrações + identidade do colégio, ligado como o PRÓPRIO colégio. */
async function migrateAs(job: Job, url: string, ctx: ProvisionContext) {
  const tenant = new TenantClient({ datasources: { db: { url } }, log: ["warn", "error"] });
  try {
    const applied = await migrateTenant(tenant);
    await tenant.tenantInfo.upsert({
      where: { id: 1 },
      create: { id: 1, schoolId: job.school_id, slug: job.slug, name: job.school_name },
      update: { slug: job.slug, name: job.school_name },
    });
    if (applied.length) ctx.log(`${job.slug}: migrações aplicadas → ${applied.join(", ")}`);
  } finally {
    await tenant.$disconnect();
  }
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
    active: true,
  };
  await ctx.platform.tenantDatabase.upsert({ where: { schoolId: job.school_id }, create: { schoolId: job.school_id, ...directory }, update: directory });
}

/**
 * SERVIDOR PARTILHADO: cria um utilizador e uma BD próprios do colégio.
 * O provisioner só tem acesso ao utilizador do colégio DURANTE a criação e
 * retira-o a si próprio no fim (mantém só a gestão, não os dados).
 */
export async function provisionOnSharedServer(job: Job, admin: PostgresUrl, at: Placement, ctx: ProvisionContext) {
  // nomes derivados do id (sem dados pessoais) e validados — nunca vêm do utilizador
  const name = `tenant_${job.school_id.replace(/-/g, "").slice(0, 12)}`;
  if (!/^tenant_[0-9a-f]{12}$/.test(name)) throw new Error(`Nome inválido: ${name}`);
  const password = randomBytes(24).toString("hex"); // hex: seguro dentro de '…'

  const client = pgClient(admin);
  await client.connect();
  try {
    const version = Number((await client.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)).rows[0]!.v);
    const exists = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [name])).rowCount;
    await client.query(
      exists
        ? `ALTER ROLE "${name}" WITH LOGIN PASSWORD '${password}'`
        : `CREATE ROLE "${name}" WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 30`,
    );

    // PG16+: a pertença precisa de SET (para CREATE DATABASE … OWNER) — retirada no fim
    await client.query(version >= 160000 ? `GRANT "${name}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE` : `GRANT "${name}" TO CURRENT_USER`);
    try {
      const dbExists = (await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount;
      if (!dbExists) await client.query(`CREATE DATABASE "${name}" OWNER "${name}"`);
      await client.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
      await migrateAs(job, prismaUrl(at, name, password, name), ctx);
    } finally {
      await client.query(`REVOKE "${name}" FROM CURRENT_USER`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  await register(job, at, { name, user: name, password }, ctx);
  ctx.log(`✓ ${job.slug} → base de dados ${name} pronta em ${at.host}:${at.port}`);
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
  } finally {
    await client.end().catch(() => undefined);
  }

  const at: Placement = { host: url.host, port: url.port, sslMode: url.sslMode, serverId };
  await migrateAs(job, prismaUrl(at, url.user, url.password, url.database), ctx);
  await register(job, at, { name: url.database, user: url.user, password: url.password }, ctx);
  ctx.log(`✓ ${job.slug} → base de dados dedicada ${url.database} pronta em ${url.host}:${url.port}`);
}
