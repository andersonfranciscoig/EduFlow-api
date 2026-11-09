import { Controller, Get, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { PlatformModule } from "./modules/platform/platform.module";
import { validateEnv } from "./config/env";

@ApiTags("Sistema")
@Controller("health")
class HealthController {
  @Get()
  @SkipThrottle()
  @ApiOperation({ summary: "Estado da API" })
  check() {
    return { status: "ok", service: "platform-api", time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    // Cada serviço lê só o seu próprio .env
    ConfigModule.forRoot({ isGlobal: true, cache: true, envFilePath: "apps/platform-api/.env", ignoreEnvFile: process.env.NODE_ENV === "production", validate: validateEnv }),
    // Limite global por IP; rotas sensíveis (login, registo) têm limites próprios.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),

    // Módulo 1 — gestão da empresa EduFlow (o Módulo 2 vive em apps/school-api)
    PlatformModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
