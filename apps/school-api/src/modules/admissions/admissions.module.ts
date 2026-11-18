import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { AdmissionSettings } from "./application/AdmissionSettings";
import { AdmissionSettingsController } from "./presentation/admission-settings.controller";

/**
 * Contexto "Secretaria · Inscrições e matrículas" (na BD de cada colégio).
 * Fase A1: configuração — períodos de cada ano letivo e documentos pedidos.
 * (Seguem-se: formulários, alunos e encarregados, inscrição pública, análise, matrícula, renovação.)
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard + PermissionsGuard
  controllers: [AdmissionSettingsController],
  providers: [{ provide: AdmissionSettings, useFactory: () => new AdmissionSettings(uuidGenerator, systemClock) }],
})
export class AdmissionsModule {}
