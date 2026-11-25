import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { TenantDirectory } from "../../tenancy/tenant-directory";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Expenses } from "./application/Expenses";
import { FinanceReports } from "./application/FinanceReports";
import { Payments } from "./application/Payments";
import { Pricing } from "./application/Pricing";
import { Reminders } from "./application/Reminders";
import { PaymentRequests } from "./infrastructure/payment-requests";
import { ExpensesController } from "./presentation/expenses.controller";
import { FamilyPaymentsController, PaymentsController } from "./presentation/payments.controller";
import { PricingController } from "./presentation/pricing.controller";
import { FinanceReportsController } from "./presentation/reports.controller";
import { SubscriptionController } from "./presentation/subscription.controller";

/**
 * Contexto "Finanças" do portal (na BD de cada colégio): o preçário (rubricas, preço por classe/curso,
 * calendário das propinas) os pagamentos (cobranças, transferência/depósito, validação manual),
 * os lembretes das propinas, as despesas, o painel e os relatórios.
 */
@Module({
  // sessões (equipa e família) · ficheiros cifrados do colégio · avisos
  imports: [IdentityModule, FamilyModule, HrModule, NotificationsModule],
  controllers: [PricingController, PaymentsController, FamilyPaymentsController, ExpensesController, FinanceReportsController, SubscriptionController],
  providers: [
    { provide: Pricing, useFactory: () => new Pricing(uuidGenerator, systemClock) },
    { provide: Payments, useFactory: () => new Payments(uuidGenerator, systemClock) },
    { provide: Reminders, useFactory: () => new Reminders(systemClock) },
    { provide: Expenses, useFactory: () => new Expenses(uuidGenerator, systemClock) },
    { provide: FinanceReports, useFactory: () => new FinanceReports(systemClock) },
    { provide: PaymentRequests, inject: [TenantDirectory], useFactory: (d: TenantDirectory) => new PaymentRequests(d) },
  ],
  exports: [Payments, Reminders],
})
export class FinanceModule {}
