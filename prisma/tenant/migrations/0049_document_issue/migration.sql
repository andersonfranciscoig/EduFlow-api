-- DOCUMENTOS (D4–D6): modelos com versões e emissão automática (PDF), documentos preparados fora
-- e carregados, versões emitidas, e as taxas ligadas às cobranças das Finanças.
--
--   document_templates     cada versão do modelo de um tipo (só de acrescentar): título, texto com
--                          campos {{...}}, quem assina; a mais recente é a que se usa
--   issued_documents       cada versão emitida de um pedido (gerada ou carregada): ficheiro cifrado
--                          no armazenamento do colégio, n.º, versão; a anterior fica "substituída"
--   document_types.fee_policy   BEFORE (só se prepara depois de pago) | ON_DELIVERY (prepara-se já;
--                          só se entrega ou descarrega depois de pago)
--   document_requests.charge_id  a cobrança da taxa (kind DOCUMENTO); o pagamento valida-o as Finanças

ALTER TABLE "document_types" ADD COLUMN "fee_policy" TEXT NOT NULL DEFAULT 'BEFORE';
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_fee_policy_check" CHECK ("fee_policy" IN ('BEFORE', 'ON_DELIVERY'));
-- só os documentos dos alunos têm taxa (os funcionários não pagam pela área da família)
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_fee_audience_check" CHECK ("fee" IS NULL OR "audience" = 'STUDENT');

ALTER TABLE "document_requests" ADD COLUMN "fee_policy" TEXT;
ALTER TABLE "document_requests" ADD COLUMN "charge_id" UUID;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_charge_fkey" FOREIGN KEY ("charge_id") REFERENCES "charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "document_requests_charge_idx" ON "document_requests"("charge_id") WHERE "charge_id" IS NOT NULL;

-- o histórico ganha os ficheiros (emitido, carregado, descarregado)
ALTER TABLE "document_request_events" DROP CONSTRAINT "document_request_events_kind_check";
ALTER TABLE "document_request_events" ADD CONSTRAINT "document_request_events_kind_check" CHECK ("kind" IN ('STATUS', 'NOTE', 'FILE', 'PAYMENT'));

CREATE TABLE "document_templates" (
    "id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "signer_name" TEXT,
    "signer_role" TEXT,
    "show_logo" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_templates_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "document_templates_version_key" ON "document_templates"("type_id", "version");
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_type_fkey" FOREIGN KEY ("type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION document_templates_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'document_templates é só de acrescentar';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER document_templates_no_update BEFORE UPDATE OR DELETE ON "document_templates" FOR EACH ROW EXECUTE FUNCTION document_templates_append_only();

CREATE TABLE "issued_documents" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    -- AUTO (gerado com o modelo) | EXTERNAL (preparado fora e carregado)
    "method" TEXT NOT NULL,
    "template_version" INTEGER,
    "file_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    -- ACTIVE | REPLACED (a versão seguinte substituiu-a)
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "replaced_at" TIMESTAMP(3),
    CONSTRAINT "issued_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "issued_documents_method_check" CHECK ("method" IN ('AUTO', 'EXTERNAL')),
    CONSTRAINT "issued_documents_status_check" CHECK ("status" IN ('ACTIVE', 'REPLACED')),
    CONSTRAINT "issued_documents_mime_check" CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'))
);
CREATE UNIQUE INDEX "issued_documents_version_key" ON "issued_documents"("request_id", "version");
-- um só ficheiro ativo por pedido
CREATE UNIQUE INDEX "issued_documents_active_key" ON "issued_documents"("request_id") WHERE "status" = 'ACTIVE';
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_request_fkey" FOREIGN KEY ("request_id") REFERENCES "document_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
