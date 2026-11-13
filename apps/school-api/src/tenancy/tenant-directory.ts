import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient as PlatformClient } from ".prisma/platform-client";
import type { Env } from "../config/env";

export interface TenantEntry {
  schoolId: string;
  slug: string;
  schoolName: string;
  /** Logótipo público (null = sem logótipo). */
  logoUrl: string | null;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  passwordCiphertext: string;
  /** disable | require | verify-ca | verify-full */
  sslMode: string;
  /** A app do UploadThing do colégio (token SELADO; abre-se com a chave privada das credenciais). null = por configurar. */
  storage: { appId: string; tokenSealed: string } | null;
}

/** Colégio encontrado: revalidado a cada minuto (desativar tem efeito em ≤ 60 s). */
const FOUND_TTL_MS = 60_000;
/** "Não existe": guardado pouco tempo, para um colégio novo aparecer depressa. */
const MISSING_TTL_MS = 10_000;
/** Limite de entradas: slugs inventados não fazem crescer a memória sem fim. */
const MAX_ENTRIES = 2_000;

/**
 * Diretório de colégios. Liga-se à BD da plataforma com um utilizador que SÓ
 * pode ler a tabela tenant_databases — mesmo comprometido, não vê equipa,
 * faturação nem dados dos colégios.
 */
@Injectable()
export class TenantDirectory implements OnModuleDestroy {
  private readonly db: PlatformClient;
  /** LRU: o Map mantém a ordem de inserção (a mais antiga sai primeiro). */
  private readonly cache = new Map<string, { entry: TenantEntry | null; expiresAt: number }>();
  /** Pedidos em curso: muitos pedidos ao mesmo slug fazem UMA consulta. */
  private readonly inflight = new Map<string, Promise<TenantEntry | null>>();

  constructor(config: ConfigService<Env, true>) {
    this.db = new PlatformClient({
      datasources: { db: { url: config.get("DIRECTORY_DATABASE_URL", { infer: true }) } },
      log: ["warn", "error"],
    });
  }

  async findBySlug(slug: string): Promise<TenantEntry | null> {
    const hit = this.cache.get(slug);
    if (hit && hit.expiresAt > Date.now()) {
      this.cache.delete(slug);
      this.cache.set(slug, hit);
      return hit.entry;
    }

    const pending = this.inflight.get(slug);
    if (pending) return pending;

    const lookup = this.lookup(slug).finally(() => this.inflight.delete(slug));
    this.inflight.set(slug, lookup);
    return lookup;
  }

  private async lookup(slug: string) {
    const row = await this.db.tenantDatabase.findUnique({
      where: { slug },
      select: {
        schoolId: true,
        slug: true,
        schoolName: true,
        dbHost: true,
        dbPort: true,
        dbName: true,
        dbUser: true,
        passwordCiphertext: true,
        sslMode: true,
        active: true,
        // da tabela schools só pode ler id e logo_url (ver infra/db/grants.sql)
        school: { select: { logoUrl: true, storage: { select: { appId: true, tokenSealed: true } } } },
      },
    });
    const entry: TenantEntry | null = row?.active
      ? {
          schoolId: row.schoolId,
          slug: row.slug,
          schoolName: row.schoolName,
          logoUrl: row.school.logoUrl,
          dbHost: row.dbHost,
          dbPort: row.dbPort,
          dbName: row.dbName,
          dbUser: row.dbUser,
          passwordCiphertext: row.passwordCiphertext,
          sslMode: row.sslMode,
          storage: row.school.storage ? { appId: row.school.storage.appId, tokenSealed: row.school.storage.tokenSealed } : null,
        }
      : null;

    this.cache.delete(slug);
    this.cache.set(slug, { entry, expiresAt: Date.now() + (entry ? FOUND_TTL_MS : MISSING_TTL_MS) });
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }

  onModuleDestroy() {
    return this.db.$disconnect();
  }
}
