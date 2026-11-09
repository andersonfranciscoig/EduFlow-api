import { randomBytes } from "node:crypto";
import { PrismaClient as PlatformClient } from ".prisma/platform-client";
import { PrismaClient as TenantClient } from ".prisma/tenant-client";
import { encryptSecret, readKeyFile } from "../../../libs/kernel/src/infrastructure/keys";
import { loadEnv } from "./env";
import { migrateTenant } from "./tenant-migrator";

/**
 * PROVISIONER — cria a base de dados de cada colégio ativado.
 *
 * Não está exposto à internet (não abre portas). Lê a fila
 * tenant_provisioning_jobs (escrita pela plataforma na ativação), e para cada
 * pedido:
 *   1. cria um utilizador PostgreSQL próprio do colégio (senha aleatória);
 *   2. cria a base de dados do colégio, com esse utilizador como dono, e fecha
 *      o acesso a qualquer outro utilizador;
 *   3. aplica as migrações do colégio (como o próprio colégio);
 *   4. cifra a senha com a chave PÚBLICA do school-api e regista-a no diretório.
 */
const env = loadEnv();
const publicKey = readKeyFile(env.TENANT_CREDENTIALS_PUBLIC_KEY_FILE);
const platform = new PlatformClient({ datasources: { db: { url: env.PROVISIONER_DATABASE_URL } }, log: ["warn", "error"] });

type Job = { id: string; school_id: string; slug: string; school_name: string; attempts: number };

const log = (msg: string) => console.log(`[provisioner] ${new Date().toISOString()} ${msg}`);

/** Reserva o próximo pedido (seguro com vários provisioners em paralelo). */
async function claimJob(): Promise<Job | null> {
  const rows = await platform.$queryRawUnsafe<Job[]>(
    `UPDATE tenant_provisioning_jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM tenant_provisioning_jobs
       WHERE status = 'PENDING'
          OR (status = 'FAILED' AND attempts < $1 AND updated_at < now() - interval '30 seconds')
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, school_id, slug, school_name, attempts`,
    env.MAX_ATTEMPTS,
  );
  return rows[0] ?? null;
}

async function provision(job: Job) {
  // nomes derivados do id (sem dados pessoais) e validados — nunca vêm do utilizador
  const name = `tenant_${job.school_id.replace(/-/g, "").slice(0, 12)}`;
  if (!/^tenant_[0-9a-f]{12}$/.test(name)) throw new Error(`Nome inválido: ${name}`);
  const password = randomBytes(24).toString("hex");

  // 1. utilizador do colégio (se já existir de uma tentativa anterior, só renova a senha)
  const roleExists = await platform.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_roles WHERE rolname = $1`, name);
  await platform.$executeRawUnsafe(
    roleExists.length
      ? `ALTER ROLE "${name}" WITH LOGIN PASSWORD '${password}'`
      : `CREATE ROLE "${name}" WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 30`,
  );

  // O provisioner só tem acesso ao utilizador do colégio DURANTE a criação.
  // No fim retira-o a si próprio (fica apenas com a pertença administrativa,
  // que permite gerir o utilizador mas NÃO dá acesso aos dados do colégio).
  await platform.$executeRawUnsafe(`GRANT "${name}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
  try {
    await createDatabaseAndMigrate(job, name, password);
  } finally {
    await platform.$executeRawUnsafe(`REVOKE "${name}" FROM CURRENT_USER`);
  }
}

async function createDatabaseAndMigrate(job: Job, name: string, password: string) {
  // 2. base de dados do colégio, só acessível ao próprio colégio
  const dbExists = await platform.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = $1`, name);
  if (!dbExists.length) await platform.$executeRawUnsafe(`CREATE DATABASE "${name}" OWNER "${name}"`);
  await platform.$executeRawUnsafe(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);

  // 3. migrações + identidade do colégio, ligado como o próprio colégio
  const url = `postgresql://${name}:${password}@${env.TENANT_DB_HOST}:${env.TENANT_DB_PORT}/${name}?schema=public`;
  const tenant = new TenantClient({ datasources: { db: { url } } });
  try {
    const applied = await migrateTenant(tenant);
    await tenant.tenantInfo.upsert({
      where: { id: 1 },
      create: { id: 1, schoolId: job.school_id, slug: job.slug, name: job.school_name },
      update: { slug: job.slug, name: job.school_name },
    });
    if (applied.length) log(`${name}: migrações aplicadas → ${applied.join(", ")}`);
  } finally {
    await tenant.$disconnect();
  }

  // 4. diretório: senha cifrada com a chave pública do school-api
  const directory = {
    slug: job.slug,
    schoolName: job.school_name,
    dbHost: env.TENANT_DB_HOST,
    dbPort: env.TENANT_DB_PORT,
    dbName: name,
    dbUser: name,
    passwordCiphertext: encryptSecret(publicKey, password),
    active: true,
  };
  await platform.tenantDatabase.upsert({ where: { schoolId: job.school_id }, create: { schoolId: job.school_id, ...directory }, update: directory });
  await platform.tenantProvisioningJob.update({ where: { id: job.id }, data: { status: "DONE", lastError: null } });
  log(`✓ ${job.slug} → base de dados ${name} pronta`);
}

let running = true;
async function loop() {
  log(`a vigiar a fila (cada ${env.POLL_INTERVAL_MS} ms)`);
  while (running) {
    let job: Job | null = null;
    try {
      job = await claimJob();
      if (job) await provision(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`✗ ${job?.slug ?? "?"}: ${message}`);
      if (job) {
        await platform.tenantProvisioningJob
          .update({ where: { id: job.id }, data: { status: "FAILED", lastError: message.slice(0, 1000) } })
          .catch(() => undefined);
      }
    }
    if (!job) await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_MS));
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
