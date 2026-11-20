import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { AttendanceSettings } from "./application/AttendanceSettings";
import { Presence } from "./application/Presence";
import { TeacherOccurrences } from "./application/TeacherOccurrences";
import { AttendanceSettingsController } from "./presentation/attendance-settings.controller";
import { MyPresenceController, StudentPresenceController } from "./presentation/presence.controller";
import { TeacherOccurrencesController } from "./presentation/teacher-occurrences.controller";

/**
 * Contexto "Assiduidade e avaliação" (na BD de cada colégio): regras de assiduidade, presenças
 * dos alunos (professor e gestão), faltas e atrasos dos professores (RH) e, nas fases seguintes,
 * prazos automáticos, resumos e provas.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AttendanceSettingsController, TeacherOccurrencesController, MyPresenceController, StudentPresenceController],
  providers: [
    { provide: AttendanceSettings, useFactory: () => new AttendanceSettings(systemClock) },
    { provide: TeacherOccurrences, useFactory: () => new TeacherOccurrences(uuidGenerator, systemClock) },
    { provide: Presence, useFactory: () => new Presence(uuidGenerator, systemClock) },
  ],
  exports: [AttendanceSettings, TeacherOccurrences, Presence],
})
export class AttendanceModule {}
