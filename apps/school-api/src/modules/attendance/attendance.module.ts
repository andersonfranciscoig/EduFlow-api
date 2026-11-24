import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceSettings } from "./application/AttendanceSettings";
import { DeadlineJob } from "./application/DeadlineJob";
import { DigestJob } from "./application/DigestJob";
import { Justifications } from "./application/Justifications";
import { Pendings } from "./application/Pendings";
import { Presence } from "./application/Presence";
import { StudentAlerts } from "./application/StudentAlerts";
import { TeacherOccurrences } from "./application/TeacherOccurrences";
import { AttendanceScheduler } from "./infrastructure/attendance-scheduler";
import { AttendanceSettingsController } from "./presentation/attendance-settings.controller";
import { DigestsController, FamilyDigestsController } from "./presentation/digests.controller";
import { JustificationsController } from "./presentation/justifications.controller";
import { PendingsController } from "./presentation/pendings.controller";
import { MyPresenceController, StudentPresenceController } from "./presentation/presence.controller";
import { TeacherOccurrencesController } from "./presentation/teacher-occurrences.controller";

/**
 * Contexto "Assiduidade e avaliação" (na BD de cada colégio): regras de assiduidade, presenças
 * dos alunos (professor e gestão), faltas e atrasos dos professores (RH), o prazo das presenças
 * (tarefa automática: aulas pendentes, faltas automáticas, modelo por dia), substituições,
 * justificações, alertas de assiduidade e resumos diários.
 */
@Module({
  imports: [IdentityModule, NotificationsModule, HrModule, FamilyModule],
  controllers: [AttendanceSettingsController, TeacherOccurrencesController, MyPresenceController, StudentPresenceController, PendingsController, JustificationsController, DigestsController, FamilyDigestsController],
  providers: [
    { provide: AttendanceSettings, useFactory: () => new AttendanceSettings(systemClock) },
    { provide: TeacherOccurrences, useFactory: () => new TeacherOccurrences(uuidGenerator, systemClock) },
    { provide: Justifications, inject: [TeacherOccurrences], useFactory: (o: TeacherOccurrences) => new Justifications(uuidGenerator, systemClock, o) },
    { provide: Presence, useFactory: () => new Presence(uuidGenerator, systemClock) },
    { provide: StudentAlerts, useFactory: () => new StudentAlerts(uuidGenerator, systemClock) },
    { provide: Pendings, useFactory: () => new Pendings(uuidGenerator, systemClock) },
    { provide: DeadlineJob, inject: [AttendanceSettings], useFactory: (s: AttendanceSettings) => new DeadlineJob(s) },
    { provide: DigestJob, inject: [AttendanceSettings], useFactory: (s: AttendanceSettings) => new DigestJob(s) },
    AttendanceScheduler,
  ],
  exports: [AttendanceSettings, TeacherOccurrences, Presence, StudentAlerts],
})
export class AttendanceModule {}
