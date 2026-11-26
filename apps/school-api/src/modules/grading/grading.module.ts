import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { GradingModels } from "./application/GradingModels";
import { GradingRules } from "./application/GradingRules";
import { GradingSimulator } from "./application/GradingSimulator";
import { Gradebook } from "./application/Gradebook";
import { GradingNotices } from "./application/GradingNotices";
import { NotificationsModule } from "../notifications/notifications.module";
import { GradebookController } from "./presentation/gradebook.controller";
import { GradingSettingsController } from "./presentation/grading-settings.controller";

/**
 * Contexto "Avaliação" (na BD de cada colégio): por agora os critérios — modelos com versões,
 * elementos de avaliação e onde cada modelo se aplica; o motor de cálculo oficial (domain/engine) e o
 * simulador; a caderneta digital (avaliações, notas, menções e histórico). As pautas vêm nas fases seguintes.
 */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [GradingSettingsController, GradebookController],
  providers: [
    { provide: GradingModels, useFactory: () => new GradingModels(uuidGenerator, systemClock) },
    { provide: GradingRules, useFactory: () => new GradingRules(systemClock) },
    { provide: GradingSimulator, useFactory: () => new GradingSimulator() },
    { provide: Gradebook, useFactory: () => new Gradebook(systemClock) },
    { provide: GradingNotices, useFactory: () => new GradingNotices(systemClock) },
  ],
  exports: [GradingModels, GradingRules, GradingSimulator, Gradebook, GradingNotices],
})
export class GradingModule {}
