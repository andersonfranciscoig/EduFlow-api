import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient as TenantClient } from ".prisma/tenant-client";
import { decryptSecret, readKeyFile } from "../../../../libs/kernel/src/infrastructure/keys";
import type { Env } from "../config/env";
import type { TenantEntry } from "./tenant-directory";

/**
 * Ligações às bases de dados dos colégios. Cada colégio usa o SEU utilizador
 * PostgreSQL (que só tem acesso à sua BD). A senha é decifrada aqui, com a
 * chave privada que só o school-api possui, e nunca é registada em logs.
 */
@Injectable()
export class TenantConnections implements OnModuleDestroy {
  private readonly privateKey: string;
  private readonly max: number;
  /** LRU simples: Map mantém a ordem de inserção. */
  private readonly pool = new Map<string, TenantClient>();

  constructor(config: ConfigService<Env, true>) {
    this.privateKey = readKeyFile(config.get("TENANT_CREDENTIALS_PRIVATE_KEY_FILE", { infer: true }));
    this.max = config.get("TENANT_POOL_SIZE", { infer: true });
  }

  get(tenant: TenantEntry): TenantClient {
    const existing = this.pool.get(tenant.schoolId);
    if (existing) {
      this.pool.delete(tenant.schoolId);
      this.pool.set(tenant.schoolId, existing);
      return existing;
    }

    const password = encodeURIComponent(decryptSecret(this.privateKey, tenant.passwordCiphertext));
    const url = `postgresql://${tenant.dbUser}:${password}@${tenant.dbHost}:${tenant.dbPort}/${tenant.dbName}?schema=public&connection_limit=5`;
    const client = new TenantClient({ datasources: { db: { url } }, log: ["warn", "error"] });
    this.pool.set(tenant.schoolId, client);

    if (this.pool.size > this.max) {
      const [oldestId, oldest] = this.pool.entries().next().value!;
      this.pool.delete(oldestId);
      void oldest.$disconnect();
    }
    return client;
  }

  async onModuleDestroy() {
    await Promise.all([...this.pool.values()].map((c) => c.$disconnect()));
  }
}
