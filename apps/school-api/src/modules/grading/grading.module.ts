import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { GradingModels } from "./application/GradingModels";
import { GradingRules } from "./application/GradingRules";
import { GradingSettingsController } from "./presentation/grading-settings.controller";

/**
 * Contexto "Avaliação" (na BD de cada colégio): por agora os critérios — modelos com versões,
 * elementos de avaliação e onde cada modelo se aplica. A caderneta, o cálculo e as pautas vêm nas fases seguintes.
 */
@Module({
  imports: [IdentityModule],
  controllers: [GradingSettingsController],
  providers: [
    { provide: GradingModels, useFactory: () => new GradingModels(uuidGenerator, systemClock) },
    { provide: GradingRules, useFactory: () => new GradingRules(systemClock) },
  ],
  exports: [GradingModels, GradingRules],
})
export class GradingModule {}
