-- =============================================================================
--  Renovação da subscrição.
--
--  subscription_orders.kind     INITIAL (a da adesão) | RENEWAL. Só pode haver uma renovação por pagar de cada vez.
--  schools.suspension_cause     STAFF | EMAIL | EXPIRED — desativado por a subscrição ter terminado: renovar reativa.
--  billing_settings.grace_days  dias depois do fim até desativar sozinho (NULL = nunca: só a equipa desativa).
--  subscription_notices         avisos já enviados (30, 15, 7, 1 dias antes, no fim, 7 dias depois): cada um só uma vez.
-- =============================================================================
ALTER TABLE "subscription_orders" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'INITIAL';
ALTER TABLE "subscription_orders" ADD CONSTRAINT "subscription_orders_kind_check" CHECK ("kind" IN ('INITIAL', 'RENEWAL'));
CREATE UNIQUE INDEX "subscription_orders_open_renewal_key" ON "subscription_orders"("school_id") WHERE "kind" = 'RENEWAL' AND "status" IN ('AWAITING_PAYMENT', 'PROOF_SUBMITTED');

ALTER TABLE "schools" ADD COLUMN "suspension_cause" TEXT;
ALTER TABLE "schools" ADD CONSTRAINT "schools_suspension_cause_check" CHECK ("suspension_cause" IS NULL OR "suspension_cause" IN ('STAFF', 'EMAIL', 'EXPIRED'));

ALTER TABLE "billing_settings" ADD COLUMN "grace_days" INTEGER;
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_grace_check" CHECK ("grace_days" IS NULL OR "grace_days" BETWEEN 0 AND 90);

CREATE TABLE "subscription_notices" (
    "school_id" UUID NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    -- D30 | D15 | D7 | D1 | EXPIRED | E7
    "stage" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "subscription_notices_pkey" PRIMARY KEY ("school_id", "ends_at", "stage"),
    CONSTRAINT "subscription_notices_school_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE
);
