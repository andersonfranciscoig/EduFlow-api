import { Module } from "@nestjs/common";
import { systemClock, uuidGenerator } from "../../../../../libs/kernel/src/infrastructure/system";
import { IdentityModule } from "../identity/identity.module";
import { Pedagogy } from "./application/Pedagogy";
import { PedagogyController } from "./presentation/pedagogy.controller";

/** Contexto "Pedagógico" do portal: ano letivo → classes → turmas (na BD de cada colégio). */
@Module({
  imports: [IdentityModule], // SchoolAuthGuard (sessões de utilizadores e de suporte)
  controllers: [PedagogyController],
  providers: [{ provide: Pedagogy, useFactory: () => new Pedagogy(uuidGenerator, systemClock) }],
})
export class PedagogyModule {}
