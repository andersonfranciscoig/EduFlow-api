import { Module, type OnModuleInit } from "@nestjs/common";
import { uuidGenerator } from "../../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import { BillingService } from "./application/BillingService";
import { PrismaBillingRepository } from "./infrastructure/PrismaBillingRepository";
import { BillingController, PublicBillingController } from "./presentation/http/billing.controller";

/**
 * Contexto "Billing" do módulo Plataforma: planos, preços, definições de
 * pagamento e contas bancárias da EduFlow.
 */
@Module({
  imports: [PlatformDatabaseModule, IdentityModule],
  controllers: [PublicBillingController, BillingController],
  providers: [
    {
      provide: PrismaBillingRepository,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaBillingRepository(prisma),
    },
    {
      provide: BillingService,
      inject: [PrismaBillingRepository],
      useFactory: (repo: PrismaBillingRepository) => new BillingService(repo, uuidGenerator),
    },
  ],
  exports: [BillingService],
})
export class BillingModule implements OnModuleInit {
  constructor(private readonly repo: PrismaBillingRepository) {}

  /** Cria definições e planos iniciais na primeira execução. */
  async onModuleInit() {
    await this.repo.ensureDefaults();
  }
}
