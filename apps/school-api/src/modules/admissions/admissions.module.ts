import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { AdmissionForms } from "./application/AdmissionForms";
import { AdmissionSettings } from "./application/AdmissionSettings";
import { AdmissionSettingsController } from "./presentation/admission-settings.controller";

/**
 * Contexto "Secretaria · Inscrições e matrículas" (na BD de cada colégio).
 * Fase A: configuração — períodos de cada ano letivo, documentos pedidos e formulários
 * (dados fixos do aluno e do encarregado, secções e campos do colégio, condições, versões).
 * (Seguem-se: alunos e encarregados, inscrição pública, análise, matrícula, renovação.)
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard + PermissionsGuard
  controllers: [AdmissionSettingsController],
  providers: [
    { provide: AdmissionSettings, useFactory: () => new AdmissionSettings(uuidGenerator, systemClock) },
    { provide: AdmissionForms, useFactory: () => new AdmissionForms(uuidGenerator, systemClock) },
  ],
})
export class AdmissionsModule {}
