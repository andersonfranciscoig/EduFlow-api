import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { Pricing } from "./application/Pricing";
import { PricingController } from "./presentation/pricing.controller";

/**
 * Contexto "Finanças" do portal (na BD de cada colégio).
 * Por agora: o preçário (rubricas, preço por classe/curso, calendário das propinas).
 * As cobranças aos alunos e os pagamentos vêm com a matrícula.
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard (sessões de utilizadores e de suporte)
  controllers: [PricingController],
  providers: [{ provide: Pricing, useFactory: () => new Pricing(uuidGenerator, systemClock) }],
})
export class FinanceModule {}
