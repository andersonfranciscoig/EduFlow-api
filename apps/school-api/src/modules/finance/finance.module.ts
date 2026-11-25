import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { TenantDirectory } from "../../tenancy/tenant-directory";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Payments } from "./application/Payments";
import { Pricing } from "./application/Pricing";
import { PaymentRequests } from "./infrastructure/payment-requests";
import { FamilyPaymentsController, PaymentsController } from "./presentation/payments.controller";
import { PricingController } from "./presentation/pricing.controller";

/**
 * Contexto "Finanças" do portal (na BD de cada colégio): o preçário (rubricas, preço por classe/curso,
 * calendário das propinas) e os pagamentos (cobranças, transferência/depósito, validação manual).
 */
@Module({
  // sessões (equipa e família) · ficheiros cifrados do colégio · avisos
  imports: [IdentityModule, FamilyModule, HrModule, NotificationsModule],
  controllers: [PricingController, PaymentsController, FamilyPaymentsController],
  providers: [
    { provide: Pricing, useFactory: () => new Pricing(uuidGenerator, systemClock) },
    { provide: Payments, useFactory: () => new Payments(uuidGenerator, systemClock) },
    { provide: PaymentRequests, inject: [TenantDirectory], useFactory: (d: TenantDirectory) => new PaymentRequests(d) },
  ],
  exports: [Payments],
})
export class FinanceModule {}
