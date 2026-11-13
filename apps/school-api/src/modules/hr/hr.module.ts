import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { HrSettings } from "./application/HrSettings";
import { HrSettingsController } from "./presentation/hr-settings.controller";

/**
 * Contexto "Recursos Humanos" do portal (na BD de cada colégio).
 * Fase 1: configuração do cadastro de funcionários (campos, documentos, versões).
 * Pedidos de cadastro, convites, formulário e funcionários chegam nas fases seguintes.
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard + PermissionsGuard
  controllers: [HrSettingsController],
  providers: [{ provide: HrSettings, useFactory: () => new HrSettings(uuidGenerator, systemClock) }],
})
export class HrModule {}
