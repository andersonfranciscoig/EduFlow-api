import { Module } from "@nestjs/common";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { AttendanceSettings } from "./application/AttendanceSettings";
import { AttendanceSettingsController } from "./presentation/attendance-settings.controller";

/**
 * Contexto "Assiduidade e avaliação" (na BD de cada colégio): regras de assiduidade e,
 * nas fases seguintes, presenças dos alunos, ocorrências dos professores, resumos e provas.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AttendanceSettingsController],
  providers: [{ provide: AttendanceSettings, useFactory: () => new AttendanceSettings(systemClock) }],
  exports: [AttendanceSettings],
})
export class AttendanceModule {}
