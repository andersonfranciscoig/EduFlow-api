import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { GradingModels } from "./application/GradingModels";
import { GradingRules } from "./application/GradingRules";
import { GradingSimulator } from "./application/GradingSimulator";
import { Gradebook } from "./application/Gradebook";
import { GradingNotices } from "./application/GradingNotices";
import { YearResults } from "./application/YearResults";
import { GradeSheets } from "./application/GradeSheets";
import { GradingDashboard } from "./application/GradingDashboard";
import { NotificationsModule } from "../notifications/notifications.module";
import { GradebookController } from "./presentation/gradebook.controller";
import { GradingSettingsController } from "./presentation/grading-settings.controller";
import { GradeSheetsController } from "./presentation/sheets.controller";

/**
 * Contexto "Avaliação" (na BD de cada colégio): por agora os critérios — modelos com versões,
 * elementos de avaliação e onde cada modelo se aplica; o motor de cálculo oficial (domain/engine) e o
 * simulador; a caderneta digital (avaliações, notas, menções e histórico); o fecho dos períodos
 * (submeter, validar, publicar, retificar); o final do ano, as regras de transição e os resultados;
 * as pautas (A4 e .xlsx) e o painel da avaliação.
 */
@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [GradingSettingsController, GradebookController, GradeSheetsController],
  providers: [
    { provide: GradingModels, useFactory: () => new GradingModels(uuidGenerator, systemClock) },
    { provide: GradingRules, useFactory: () => new GradingRules(systemClock) },
    { provide: GradingSimulator, useFactory: () => new GradingSimulator() },
    { provide: Gradebook, useFactory: () => new Gradebook(systemClock) },
    { provide: GradingNotices, useFactory: () => new GradingNotices(systemClock) },
    { provide: YearResults, useFactory: () => new YearResults(systemClock) },
    { provide: GradeSheets, useFactory: () => new GradeSheets(systemClock) },
    { provide: GradingDashboard, useFactory: () => new GradingDashboard(systemClock) },
  ],
  exports: [GradingModels, GradingRules, GradingSimulator, Gradebook, GradingNotices, YearResults, GradeSheets, GradingDashboard],
})
export class GradingModule {}
