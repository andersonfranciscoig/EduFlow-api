import { Module } from "@nestjs/common";
import { systemClock } from "../../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import { PlatformOverview } from "./application/PlatformOverview";
import { PrismaInsightsQuery } from "./infrastructure/PrismaInsightsQuery";
import { OverviewController } from "./presentation/overview.controller";

/**
 * Contexto "Insights": números agregados para a visão geral do painel.
 * Só lê (contagens e somas) — não altera nada nem expõe dados pessoais.
 */
@Module({
  imports: [PlatformDatabaseModule, IdentityModule],
  controllers: [OverviewController],
  providers: [
    {
      provide: PlatformOverview,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PlatformOverview(new PrismaInsightsQuery(prisma), systemClock),
    },
  ],
})
export class InsightsModule {}
