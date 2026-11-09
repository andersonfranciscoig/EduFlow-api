import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from ".prisma/platform-client";
import type { Env } from "../../../config/env";

/**
 * Ligação à base de dados da PLATAFORMA (dados da empresa EduFlow).
 * Cada colégio terá a sua própria base de dados, gerida pelo módulo School.
 */
@Injectable()
export class PlatformPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({
      datasources: { db: { url: config.get("PLATFORM_DATABASE_URL", { infer: true }) } },
      log: ["warn", "error"],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
