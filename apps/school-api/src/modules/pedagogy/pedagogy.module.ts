import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { Pedagogy } from "./application/Pedagogy";
import { Teaching } from "./application/Teaching";
import { Timetable } from "./application/Timetable";
import { PedagogyController } from "./presentation/pedagogy.controller";
import { TeachingController } from "./presentation/teaching.controller";
import { TimetableController } from "./presentation/timetable.controller";

/**
 * Contexto "Pedagógico" do portal (na BD de cada colégio):
 * ano letivo → cursos → classes → turmas → vagas; disciplinas, plano curricular e horários;
 * professores (disciplinas por turma, coordenadores, choques, horário de cada professor).
 */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard (sessões de utilizadores e de suporte)
  controllers: [PedagogyController, TimetableController, TeachingController],
  providers: [
    { provide: Pedagogy, useFactory: () => new Pedagogy(uuidGenerator, systemClock) },
    { provide: Timetable, inject: [Pedagogy], useFactory: (p: Pedagogy) => new Timetable(uuidGenerator, systemClock, p) },
    { provide: Teaching, inject: [Pedagogy], useFactory: (p: Pedagogy) => new Teaching(systemClock, p) },
  ],
})
export class PedagogyModule {}
