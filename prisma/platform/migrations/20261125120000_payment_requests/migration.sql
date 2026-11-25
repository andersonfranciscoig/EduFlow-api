-- =============================================================================
--  Pagamentos — lado da plataforma.
--
--  payment_integration_requests  lista de espera: os colégios que pediram pagamento por referência
--                                ou Multicaixa Express (cada um terá a sua chave de integração, em breve).
--                                O school-api só insere/retira pedidos (ver infra/db/grants.sql).
--  subscription_orders           pagamento da subscrição por transferência OU depósito, com a data do
--                                pagamento e o prazo da validação (48 h).
-- =============================================================================
CREATE TABLE "payment_integration_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    -- REFERENCIA | EXPRESS
    "method" TEXT NOT NULL,
    -- WAITING (na lista) | CONTACTED | DONE | DECLINED | CANCELLED (o colégio retirou)
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "note" TEXT,
    "requested_by_name" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staff_note" TEXT,
    "handled_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_integration_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_integration_requests_method_check" CHECK ("method" IN ('REFERENCIA', 'EXPRESS')),
    CONSTRAINT "payment_integration_requests_status_check" CHECK ("status" IN ('WAITING', 'CONTACTED', 'DONE', 'DECLINED', 'CANCELLED')),
    CONSTRAINT "payment_integration_requests_note_check" CHECK (char_length(coalesce("note", '')) <= 500 AND char_length(coalesce("staff_note", '')) <= 500),
    CONSTRAINT "payment_integration_requests_school_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "payment_integration_requests_school_method_key" ON "payment_integration_requests"("school_id", "method");
CREATE INDEX "payment_integration_requests_status_idx" ON "payment_integration_requests"("status", "requested_at");

ALTER TABLE "subscription_orders" ADD COLUMN "proof_kind" TEXT;
ALTER TABLE "subscription_orders" ADD COLUMN "proof_paid_on" DATE;
ALTER TABLE "subscription_orders" ADD CONSTRAINT "subscription_orders_proof_kind_check" CHECK ("proof_kind" IS NULL OR "proof_kind" IN ('TRANSFERENCIA', 'DEPOSITO'));
