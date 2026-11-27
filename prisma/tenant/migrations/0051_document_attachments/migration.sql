-- DOCUMENTOS: os documentos que quem pede junta, e o logótipo guardado nos cartões.
--   document_types.attachments   os documentos a juntar ao pedido (nome, obrigatório, ajuda), até 5
--   document_request_files       cada ficheiro junto (cifrado no armazenamento do colégio); juntar outro
--                                para o mesmo documento acrescenta (o mais recente é o que conta)
--   student_card_settings.logo_* o logótipo com que os cartões são emitidos (copiado para o
--                                armazenamento do colégio): reimprimir dá o mesmo cartão

ALTER TABLE "document_types" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "document_request_files" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "item_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    -- FAMILY | EMPLOYEE | STAFF
    "uploaded_by_kind" TEXT NOT NULL,
    "uploaded_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_request_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_request_files_mime_check" CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
    CONSTRAINT "document_request_files_kind_check" CHECK ("uploaded_by_kind" IN ('FAMILY', 'EMPLOYEE', 'STAFF'))
);
CREATE INDEX "document_request_files_request_idx" ON "document_request_files"("request_id", "created_at");
ALTER TABLE "document_request_files" ADD CONSTRAINT "document_request_files_request_fkey" FOREIGN KEY ("request_id") REFERENCES "document_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_card_settings" ADD COLUMN "logo_key" TEXT;
ALTER TABLE "student_card_settings" ADD COLUMN "logo_sha256" TEXT;
