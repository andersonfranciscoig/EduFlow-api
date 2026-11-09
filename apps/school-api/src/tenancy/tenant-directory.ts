import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient as PlatformClient } from ".prisma/platform-client";
import type { Env } from "../config/env";

export interface TenantEntry {
  schoolId: string;
  slug: string;
  schoolName: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  passwordCiphertext: string;
}

const TTL_MS = 60_000;

/**
 * Diretório de colégios. Liga-se à BD da plataforma com um utilizador que SÓ
 * pode ler a tabela tenant_databases — mesmo comprometido, não vê equipa,
 * faturação nem dados dos colégios.
 */
@Injectable()
export class TenantDirectory implements OnModuleDestroy {
  private readonly db: PlatformClient;
  private readonly cache = new Map<string, { entry: TenantEntry | null; at: number }>();

  constructor(config: ConfigService<Env, true>) {
    this.db = new PlatformClient({
      datasources: { db: { url: config.get("DIRECTORY_DATABASE_URL", { infer: true }) } },
      log: ["warn", "error"],
    });
  }

  async findBySlug(slug: string): Promise<TenantEntry | null> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.entry;

    const row = await this.db.tenantDatabase.findUnique({ where: { slug } });
    const entry = row && row.active ? row : null;
    this.cache.set(slug, { entry, at: Date.now() });
    return entry;
  }

  onModuleDestroy() {
    return this.db.$disconnect();
  }
}
