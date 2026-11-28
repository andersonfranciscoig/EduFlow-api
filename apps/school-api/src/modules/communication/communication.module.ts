import { Module } from "@nestjs/common";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Announcements } from "./application/Announcements";
import { Conversations } from "./application/Conversations";
import { AnnouncementsController, FamilyAnnouncementsController } from "./presentation/announcements.controller";
import { FamilyMessagesController, MessagesController } from "./presentation/messages.controller";

/**
 * Contexto "Comunicação" (na BD de cada colégio):
 *  C1 avisos — categorias, rascunho/agendado/publicado/arquivado, destinatários sem repetidos, leitura e confirmação, anexos;
 *  C2 mensagens individuais — quem pode falar com quem pelas relações académicas e pela configuração do colégio;
 *  C3 grupos — manuais ou ligados a turmas, classes, departamentos e à equipa (membros sincronizados);
 *  C4 contadores para a consulta curta do portal (o tempo real; a persistência não depende dela).
 */
@Module({
  imports: [IdentityModule, FamilyModule, HrModule, NotificationsModule],
  controllers: [AnnouncementsController, FamilyAnnouncementsController, MessagesController, FamilyMessagesController],
  providers: [
    { provide: Announcements, useFactory: () => new Announcements(systemClock) },
    { provide: Conversations, useFactory: () => new Conversations(systemClock) },
  ],
  exports: [Announcements, Conversations],
})
export class CommunicationModule {}
