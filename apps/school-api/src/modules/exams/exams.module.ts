import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { AttendanceModule } from "../attendance/attendance.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Exams } from "./application/Exams";
import { ExamsController } from "./presentation/exams.controller";

/**
 * Contexto "Calendário de provas" (na BD de cada colégio): o modelo de avaliação, as épocas, as provas
 * e a publicação. As aulas suspensas por uma época com interrupção estão em `infrastructure/exam-break`.
 * Os avisos (ExamNotices) são do AttendanceModule, que também os retoma no ciclo automático.
 */
@Module({
  imports: [IdentityModule, NotificationsModule, AttendanceModule],
  controllers: [ExamsController],
  providers: [{ provide: Exams, useFactory: () => new Exams(uuidGenerator, systemClock) }],
  exports: [Exams],
})
export class ExamsModule {}
