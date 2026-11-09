import { Controller, Get, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env";
import { TenantConnections } from "./tenancy/tenant-connections";
import { TenantGuard } from "./tenancy/tenant-context";
import { TenantController } from "./tenancy/tenant.controller";
import { TenantDirectory } from "./tenancy/tenant-directory";

@ApiTags("Sistema")
@Controller("health")
class HealthController {
  @Get()
  @SkipThrottle()
  @ApiOperation({ summary: "Estado do serviço" })
  check() {
    return { status: "ok", service: "school-api", time: new Date().toISOString() };
  }
}

/**
 * MÓDULO 2 — Portal de cada colégio.
 * Serviço isolado: lê só o diretório de colégios e liga-se a cada BD de colégio
 * com o utilizador desse colégio. Não tem acesso à plataforma.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: "apps/school-api/.env",
      ignoreEnvFile: process.env.NODE_ENV === "production",
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
  ],
  controllers: [HealthController, TenantController],
  providers: [TenantDirectory, TenantConnections, TenantGuard, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
