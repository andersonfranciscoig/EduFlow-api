import { Module } from "@nestjs/common";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import { FamilyModule } from "../family/family.module";
import { HrModule } from "../hr/hr.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentIssuing } from "./application/DocumentIssuing";
import { DocumentRequests } from "./application/DocumentRequests";
import { DocumentTypes } from "./application/DocumentTypes";
import { DocumentsController } from "./presentation/documents.controller";
import { FamilyDocumentsController } from "./presentation/family-documents.controller";

/**
 * Contexto "Documentos" (na BD de cada colégio): os tipos de documento que se podem pedir, os
 * pedidos da família, dos funcionários e do balcão, a máquina de estados, as notas e as entregas.
 * A emissão automática (modelos + PDF), o documento carregado, os downloads protegidos e as taxas
 * (cobranças das Finanças). Os cartões de estudante chegam na fase seguinte.
 */
@Module({
  imports: [IdentityModule, FamilyModule, HrModule, NotificationsModule],
  controllers: [DocumentsController, FamilyDocumentsController],
  providers: [
    { provide: DocumentTypes, useFactory: () => new DocumentTypes(systemClock) },
    { provide: DocumentRequests, useFactory: () => new DocumentRequests(systemClock) },
    { provide: DocumentIssuing, useFactory: (requests: DocumentRequests) => new DocumentIssuing(systemClock, requests), inject: [DocumentRequests] },
  ],
  exports: [DocumentTypes, DocumentRequests, DocumentIssuing],
})
export class DocumentsModule {}
