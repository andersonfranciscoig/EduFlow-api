import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { AttendanceSettings } from "./application/AttendanceSettings";
import { TeacherOccurrences } from "./application/TeacherOccurrences";
import { AttendanceSettingsController } from "./presentation/attendance-settings.controller";
import { TeacherOccurrencesController } from "./presentation/teacher-occurrences.controller";

/**
 * Contexto "Assiduidade e avaliação" (na BD de cada colégio): regras de assiduidade, faltas e
 * atrasos dos professores (RH) e, nas fases seguintes, presenças dos alunos, resumos e provas.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AttendanceSettingsController, TeacherOccurrencesController],
  providers: [
    { provide: AttendanceSettings, useFactory: () => new AttendanceSettings(systemClock) },
    { provide: TeacherOccurrences, useFactory: () => new TeacherOccurrences(uuidGenerator, systemClock) },
  ],
  exports: [AttendanceSettings, TeacherOccurrences],
})
export class AttendanceModule {}
