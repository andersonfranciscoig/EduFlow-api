import { Module } from "@nestjs/common";
import { systemClock } from "../../../../../libs/kernel/src/infrastructure/system";
import { FamilyModule } from "../family/family.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DocumentRequests } from "./application/DocumentRequests";
import { DocumentTypes } from "./application/DocumentTypes";
import { DocumentsController } from "./presentation/documents.controller";
import { FamilyDocumentsController } from "./presentation/family-documents.controller";

/**
 * Contexto "Documentos" (na BD de cada colégio): os tipos de documento que se podem pedir, os
 * pedidos da família, dos funcionários e do balcão, a máquina de estados, as notas e as entregas.
 * A emissão (automática e externa), as taxas e os cartões de estudante chegam nas fases seguintes.
 */
@Module({
  imports: [IdentityModule, FamilyModule, NotificationsModule],
  controllers: [DocumentsController, FamilyDocumentsController],
  providers: [
    { provide: DocumentTypes, useFactory: () => new DocumentTypes(systemClock) },
    { provide: DocumentRequests, useFactory: () => new DocumentRequests(systemClock) },
  ],
  exports: [DocumentTypes, DocumentRequests],
})
export class DocumentsModule {}
