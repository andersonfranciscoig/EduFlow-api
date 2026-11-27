import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../config/env";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentIssuing } from "./application/DocumentIssuing";
import { DocumentReports } from "./application/DocumentReports";
import { DocumentRequests } from "./application/DocumentRequests";
import { DocumentTypes } from "./application/DocumentTypes";
import { StudentCards } from "./application/StudentCards";
import { CardsController, PublicCardsController } from "./presentation/cards.controller";
import { DocumentsController } from "./presentation/documents.controller";
import { FamilyDocumentsController } from "./presentation/family-documents.controller";

/**
 * Contexto "Documentos" (na BD de cada colégio): os tipos de documento que se podem pedir, os
 * pedidos da família, dos funcionários e do balcão, a máquina de estados, as notas e as entregas.
 * A emissão automática (modelos + PDF), o documento carregado, os downloads protegidos e as taxas
 * (cobranças das Finanças). Os cartões de estudante: três modelos da plataforma, personalização,
 * emissão individual e por turma, segunda via, impressão e verificação pública pelo QR.
 */
@Module({
  imports: [IdentityModule, FamilyModule, HrModule, NotificationsModule],
  controllers: [CardsController, PublicCardsController, DocumentsController, FamilyDocumentsController],
  providers: [
    { provide: DocumentTypes, useFactory: () => new DocumentTypes(systemClock) },
    { provide: DocumentReports, useFactory: () => new DocumentReports(systemClock) },
    { provide: DocumentRequests, useFactory: () => new DocumentRequests(systemClock) },
    { provide: StudentCards, inject: [ConfigService], useFactory: (config: ConfigService<Env, true>) => new StudentCards(systemClock, config.get("PORTAL_URL_TEMPLATE", { infer: true })) },
    { provide: DocumentIssuing, useFactory: (requests: DocumentRequests, cards: StudentCards) => new DocumentIssuing(systemClock, requests, cards), inject: [DocumentRequests, StudentCards] },
  ],
  exports: [DocumentTypes, DocumentRequests, DocumentIssuing],
})
export class DocumentsModule {}
