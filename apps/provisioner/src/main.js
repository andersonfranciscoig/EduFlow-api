"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const platform_client_1 = require(".prisma/platform-client");
const tenant_client_1 = require(".prisma/tenant-client");
const keys_1 = require("../../../libs/kernel/src/infrastructure/keys");
const env_1 = require("./env");
const tenant_migrator_1 = require("./tenant-migrator");
const env = (0, env_1.loadEnv)();
const publicKey = (0, keys_1.readKeyFile)(env.TENANT_CREDENTIALS_PUBLIC_KEY_FILE);
const platform = new platform_client_1.PrismaClient({ datasources: { db: { url: env.PROVISIONER_DATABASE_URL } }, log: ["warn", "error"] });
const log = (msg) => console.log(`[provisioner] ${new Date().toISOString()} ${msg}`);
async function claimJob() {
    const rows = await platform.$queryRawUnsafe(`UPDATE tenant_provisioning_jobs SET status = 'RUNNING', attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM tenant_provisioning_jobs
       WHERE status = 'PENDING'
          OR (status = 'FAILED' AND attempts < $1 AND updated_at < now() - interval '30 seconds')
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, school_id, slug, school_name, attempts`, env.MAX_ATTEMPTS);
    return rows[0] ?? null;
}
async function provision(job) {
    const name = `tenant_${job.school_id.replace(/-/g, "").slice(0, 12)}`;
    if (!/^tenant_[0-9a-f]{12}$/.test(name))
        throw new Error(`Nome inválido: ${name}`);
    const password = (0, node_crypto_1.randomBytes)(24).toString("hex");
    const roleExists = await platform.$queryRawUnsafe(`SELECT 1 FROM pg_roles WHERE rolname = $1`, name);
    await platform.$executeRawUnsafe(roleExists.length
        ? `ALTER ROLE "${name}" WITH LOGIN PASSWORD '${password}'`
        : `CREATE ROLE "${name}" WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 30`);
    await platform.$executeRawUnsafe(`GRANT "${name}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
    try {
        await createDatabaseAndMigrate(job, name, password);
    }
    finally {
        await platform.$executeRawUnsafe(`REVOKE "${name}" FROM CURRENT_USER`);
    }
}
async function createDatabaseAndMigrate(job, name, password) {
    const dbExists = await platform.$queryRawUnsafe(`SELECT 1 FROM pg_database WHERE datname = $1`, name);
    if (!dbExists.length)
        await platform.$executeRawUnsafe(`CREATE DATABASE "${name}" OWNER "${name}"`);
    await platform.$executeRawUnsafe(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    const url = `postgresql://${name}:${password}@${env.TENANT_DB_HOST}:${env.TENANT_DB_PORT}/${name}?schema=public`;
    const tenant = new tenant_client_1.PrismaClient({ datasources: { db: { url } } });
    try {
        const applied = await (0, tenant_migrator_1.migrateTenant)(tenant);
        await tenant.tenantInfo.upsert({
            where: { id: 1 },
            create: { id: 1, schoolId: job.school_id, slug: job.slug, name: job.school_name },
            update: { slug: job.slug, name: job.school_name },
        });
        if (applied.length)
            log(`${name}: migrações aplicadas → ${applied.join(", ")}`);
    }
    finally {
        await tenant.$disconnect();
    }
    const directory = {
        slug: job.slug,
        schoolName: job.school_name,
        dbHost: env.TENANT_DB_HOST,
        dbPort: env.TENANT_DB_PORT,
        dbName: name,
        dbUser: name,
        passwordCiphertext: (0, keys_1.encryptSecret)(publicKey, password),
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
        let job = null;
        try {
            job = await claimJob();
            if (job)
                await provision(job);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`✗ ${job?.slug ?? "?"}: ${message}`);
            if (job) {
                await platform.tenantProvisioningJob
                    .update({ where: { id: job.id }, data: { status: "FAILED", lastError: message.slice(0, 1000) } })
                    .catch(() => undefined);
            }
        }
        if (!job)
            await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_MS));
    }
    await platform.$disconnect();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        log("a terminar…");
        running = false;
    });
}
void loop();
//# sourceMappingURL=main.js.map