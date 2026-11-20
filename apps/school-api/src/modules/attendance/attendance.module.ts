import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceSettings } from "./application/AttendanceSettings";
import { DeadlineJob } from "./application/DeadlineJob";
import { Pendings } from "./application/Pendings";
import { Presence } from "./application/Presence";
import { TeacherOccurrences } from "./application/TeacherOccurrences";
import { AttendanceScheduler } from "./infrastructure/attendance-scheduler";
import { AttendanceSettingsController } from "./presentation/attendance-settings.controller";
import { PendingsController } from "./presentation/pendings.controller";
import { MyPresenceController, StudentPresenceController } from "./presentation/presence.controller";
import { TeacherOccurrencesController } from "./presentation/teacher-occurrences.controller";

/**
 * Contexto "Assiduidade e avaliação" (na BD de cada colégio): regras de assiduidade, presenças
 * dos alunos (professor e gestão), faltas e atrasos dos professores (RH), o prazo das presenças
 * (tarefa automática: aulas pendentes, faltas automáticas, modelo por dia) e substituições.
 */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [AttendanceSettingsController, TeacherOccurrencesController, MyPresenceController, StudentPresenceController, PendingsController],
  providers: [
    { provide: AttendanceSettings, useFactory: () => new AttendanceSettings(systemClock) },
    { provide: TeacherOccurrences, useFactory: () => new TeacherOccurrences(uuidGenerator, systemClock) },
    { provide: Presence, useFactory: () => new Presence(uuidGenerator, systemClock) },
    { provide: Pendings, useFactory: () => new Pendings(uuidGenerator, systemClock) },
    { provide: DeadlineJob, inject: [AttendanceSettings], useFactory: (s: AttendanceSettings) => new DeadlineJob(s) },
    AttendanceScheduler,
  ],
  exports: [AttendanceSettings, TeacherOccurrences, Presence],
})
export class AttendanceModule {}
