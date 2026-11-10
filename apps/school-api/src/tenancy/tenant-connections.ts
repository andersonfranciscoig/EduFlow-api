import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient as TenantClient } from ".prisma/tenant-client";
import { decryptSecret, readKeyFile } from "../../../../libs/kernel/src/infrastructure/keys";
import { isSslMode, tenantPrismaUrl } from "../../../../libs/kernel/src/infrastructure/tenant-url";
import type { Env } from "../config/env";
import type { TenantEntry } from "./tenant-directory";

/** Uma ligação retirada do pool só fecha depois disto (os pedidos em curso terminam). */
const CLOSE_GRACE_MS = 30_000;

/**
 * Ligações às bases de dados dos colégios. Cada colégio usa o SEU utilizador
 * PostgreSQL (que só tem acesso à sua BD), com o TLS registado para o servidor.
 * A senha é decifrada aqui, com a chave privada que só o school-api possui,
 * e nunca é registada em logs.
 */
@Injectable()
export class TenantConnections implements OnModuleDestroy {
  private readonly logger = new Logger(TenantConnections.name);
  private readonly privateKey: string;
  private readonly max: number;
  /** LRU simples: o Map mantém a ordem de inserção. */
  private readonly pool = new Map<string, { fingerprint: string; client: TenantClient }>();

  constructor(config: ConfigService<Env, true>) {
    this.privateKey = readKeyFile(config.get("TENANT_CREDENTIALS_PRIVATE_KEY_FILE", { infer: true }));
    this.max = config.get("TENANT_POOL_SIZE", { infer: true });
  }

  get(tenant: TenantEntry): TenantClient {
    // Se o provisioner rodar a senha ou mudar o servidor, a impressão digital
    // muda e a ligação antiga é substituída de imediato.
    const fingerprint = createHash("sha256")
      .update([tenant.dbHost, tenant.dbPort, tenant.dbName, tenant.dbUser, tenant.passwordCiphertext, tenant.sslMode].join("\n"))
      .digest("hex");

    const existing = this.pool.get(tenant.schoolId);
    if (existing && existing.fingerprint === fingerprint) {
      this.pool.delete(tenant.schoolId);
      this.pool.set(tenant.schoolId, existing);
      return existing.client;
    }
    if (existing) {
      this.pool.delete(tenant.schoolId);
      this.close(existing.client);
    }

    if (!isSslMode(tenant.sslMode)) {
      throw new Error(`Modo TLS desconhecido no diretório para ${tenant.slug}.`);
    }
    const url = tenantPrismaUrl(
      { host: tenant.dbHost, port: tenant.dbPort, sslMode: tenant.sslMode },
      { user: tenant.dbUser, password: decryptSecret(this.privateKey, tenant.passwordCiphertext), database: tenant.dbName },
      5,
    );
    const client = new TenantClient({ datasources: { db: { url } }, log: ["warn", "error"] });
    this.pool.set(tenant.schoolId, { fingerprint, client });

    while (this.pool.size > this.max) {
      const [oldestId, oldest] = this.pool.entries().next().value!;
      this.pool.delete(oldestId);
      this.close(oldest.client);
    }
    return client;
  }

  private close(client: TenantClient) {
    setTimeout(() => {
      client.$disconnect().catch((error: unknown) => this.logger.warn(`Falha ao fechar ligação: ${String(error)}`));
    }, CLOSE_GRACE_MS).unref();
  }

  async onModuleDestroy() {
    await Promise.all([...this.pool.values()].map((c) => c.client.$disconnect()));
  }
}
