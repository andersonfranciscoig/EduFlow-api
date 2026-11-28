import { Module } from "@nestjs/common";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Announcements } from "./application/Announcements";
import { AnnouncementsController, FamilyAnnouncementsController } from "./presentation/announcements.controller";

/**
 * Contexto "Comunicação" (na BD de cada colégio). C1: avisos — categorias, rascunho/agendado/
 * publicado/arquivado, destinatários sem repetidos, leitura e confirmação, anexos cifrados.
 * As mensagens individuais (C2), os grupos (C3) e o tempo real (C4) chegam com cada fase.
 */
@Module({
  imports: [IdentityModule, FamilyModule, HrModule, NotificationsModule],
  controllers: [AnnouncementsController, FamilyAnnouncementsController],
  providers: [{ provide: Announcements, useFactory: () => new Announcements(systemClock) }],
  exports: [Announcements],
})
export class CommunicationModule {}
