-- =============================================================================
--  FINANÇAS: lembretes das propinas e despesas do colégio.
--
--  payment_settings   + lembretes (desligados até o colégio os ligar): quantos dias antes, no próprio dia e,
--                       em atraso, de quantos em quantos dias e quantas vezes; a partir de que hora se enviam
--  charge_reminders   cada lembrete enviado a cada conta da família: BEFORE | DUE | AFTER | MANUAL (um por dia)
--  expense_categories categorias das despesas (arquivam-se, não se apagam se já têm despesas)
--  expenses           PENDING (por pagar) | PAID | CANCELLED (com motivo); comprovativo opcional (cifrado)
--  O histórico fica em school_activity.
-- =============================================================================
ALTER TABLE "payment_settings" ADD COLUMN "reminders_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payment_settings" ADD COLUMN "remind_before_days" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "payment_settings" ADD COLUMN "remind_on_due" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "payment_settings" ADD COLUMN "remind_every_days" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "payment_settings" ADD COLUMN "remind_max" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "payment_settings" ADD COLUMN "remind_hour" INTEGER NOT NULL DEFAULT 9;
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_reminders_check" CHECK ("remind_before_days" BETWEEN 0 AND 15 AND "remind_every_days" BETWEEN 1 AND 60 AND "remind_max" BETWEEN 0 AND 12 AND "remind_hour" BETWEEN 7 AND 20);

CREATE TABLE "charge_reminders" (
    "id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "stage" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "by_id" UUID,
    CONSTRAINT "charge_reminders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "charge_reminders_stage_check" CHECK ("stage" IN ('BEFORE', 'DUE', 'AFTER', 'MANUAL')),
    CONSTRAINT "charge_reminders_charge_fkey" FOREIGN KEY ("charge_id") REFERENCES "charges"("id") ON DELETE CASCADE,
    CONSTRAINT "charge_reminders_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "charge_reminders_key" ON "charge_reminders"("charge_id", "account_id", "day");

CREATE TABLE "expense_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "expense_categories_name_key" ON "expense_categories"(lower("name"));

CREATE SEQUENCE "expense_number_seq";
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL DEFAULT nextval('expense_number_seq'),
    "category_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "supplier" TEXT,
    -- fatura ou recibo
    "document_number" TEXT,
    "amount" INTEGER NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paid_on" DATE,
    -- TRANSFERENCIA | DEPOSITO | NUMERARIO | CHEQUE | OUTRO
    "method" TEXT,
    "bank_account_id" UUID,
    "bank_name" TEXT,
    "transaction_number" TEXT,
    "proof_name" TEXT,
    "proof_mime_type" TEXT,
    "proof_size" INTEGER,
    "proof_sha256" TEXT,
    "proof_storage_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "paid_by_id" UUID,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expenses_status_check" CHECK ("status" IN ('PENDING', 'PAID', 'CANCELLED')),
    CONSTRAINT "expenses_method_check" CHECK ("method" IS NULL OR "method" IN ('TRANSFERENCIA', 'DEPOSITO', 'NUMERARIO', 'CHEQUE', 'OUTRO')),
    CONSTRAINT "expenses_amount_check" CHECK ("amount" BETWEEN 1 AND 1000000000),
    CONSTRAINT "expenses_paid_check" CHECK ("status" <> 'PAID' OR ("paid_on" IS NOT NULL AND "method" IS NOT NULL)),
    CONSTRAINT "expenses_cancel_check" CHECK ("status" <> 'CANCELLED' OR char_length("cancel_reason") >= 3),
    CONSTRAINT "expenses_category_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT,
    CONSTRAINT "expenses_bank_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL
);
ALTER SEQUENCE "expense_number_seq" OWNED BY "expenses"."number";
CREATE UNIQUE INDEX "expenses_number_key" ON "expenses"("number");
CREATE INDEX "expenses_status_idx" ON "expenses"("status", "due_on");
CREATE INDEX "expenses_paid_idx" ON "expenses"("paid_on");
