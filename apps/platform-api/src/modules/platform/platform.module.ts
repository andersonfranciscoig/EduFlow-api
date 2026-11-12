import { Module } from "@nestjs/common";
import { BillingModule } from "./billing/billing.module";
import { DatabasesModule } from "./databases/databases.module";
import { IdentityModule } from "./identity/identity.module";
import { InsightsModule } from "./insights/insights.module";
import { SchoolsModule } from "./schools/schools.module";

/**
 * MÓDULO 1 — Plataforma EduFlow (gestão interna da empresa).
 * Agrupa os contextos delimitados da plataforma:
 *   - identity → equipa interna, autenticação, níveis de acesso
 *   - billing  → planos, preços, definições de pagamento, contas bancárias
 *   - schools  → colégios clientes: adesão, subscrição e ciclo de pagamento
 *   - databases → servidores/BDs dos colégios, reservas e atribuições
 *   - insights → números agregados da visão geral do painel (só leitura)
 *
 * Não depende de nenhum outro módulo de negócio, por isso pode ser extraído
 * para um serviço independente quando for preciso.
 */
@Module({
  imports: [IdentityModule, BillingModule, DatabasesModule, SchoolsModule, InsightsModule],
})
export class PlatformModule {}
