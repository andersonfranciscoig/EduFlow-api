-- =============================================================================
--  PAGAMENTOS (transferência ou depósito, validados à mão pelas Finanças).
--
--  payment_settings    (uma linha) formas de pagamento do colégio e as regras:
--      transfer_enabled     o colégio recebe por transferência/depósito
--      active_since         quando ativou (as cobranças anteriores não existem no sistema)
--      require_application  a inscrição só se aprova com a taxa de inscrição paga (validada)
--      require_enrollment   a matrícula só se faz com os valores da matrícula pagos (validados)
--      monthly_from         as propinas geram-se a partir deste mês (AAAA-MM)
--      validation_hours     prazo da validação (até 48 h)
--  bank_accounts       coordenadas bancárias do colégio
--  charges             o que se cobra: INSCRICAO | MATRICULA | PROPINA | OUTRA
--                        OPEN (por pagar) | PAID | WAIVED (isenta, com motivo) | VOID (deixou de se aplicar)
--                        "em validação" = está num pagamento SUBMITTED
--  payments            um pagamento feito pela família (ou registado pelas Finanças):
--                        SUBMITTED | VALIDATED | REJECTED (com motivo) | CANCELLED (retirado)
--                        com a conta escolhida, o n.º da transação e o comprovativo (cifrado)
--  payment_items       as cobranças que cada pagamento cobre (com a multa, se houver)
--  O histórico fica em school_activity. Referência e Express: pedidos na plataforma (lista de espera).
-- =============================================================================
CREATE TABLE "payment_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "transfer_enabled" BOOLEAN NOT NULL DEFAULT false,
    "active_since" TIMESTAMP(3),
    "require_application" BOOLEAN NOT NULL DEFAULT true,
    "require_enrollment" BOOLEAN NOT NULL DEFAULT true,
    "monthly_from" TEXT,
    "validation_hours" INTEGER NOT NULL DEFAULT 48,
    "instructions" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_settings_single" CHECK ("id" = 1),
    CONSTRAINT "payment_settings_hours_check" CHECK ("validation_hours" BETWEEN 1 AND 48),
    CONSTRAINT "payment_settings_month_check" CHECK ("monthly_from" IS NULL OR "monthly_from" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "payment_settings_since_check" CHECK (NOT "transfer_enabled" OR "active_since" IS NOT NULL)
);

CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "account_number" TEXT,
    "iban" TEXT NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_accounts_iban_key" ON "bank_accounts"("iban");

CREATE TABLE "charges" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    -- kwanzas (sem a multa)
    "amount" INTEGER NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID,
    "application_id" UUID,
    "enrollment_id" UUID,
    "fee_item_id" UUID,
    -- propina: AAAA-MM
    "month" TEXT,
    "due_on" DATE,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "paid_at" TIMESTAMP(3),
    "waive_reason" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "charges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "charges_kind_check" CHECK ("kind" IN ('INSCRICAO', 'MATRICULA', 'PROPINA', 'OUTRA')),
    CONSTRAINT "charges_status_check" CHECK ("status" IN ('OPEN', 'PAID', 'WAIVED', 'VOID')),
    CONSTRAINT "charges_amount_check" CHECK ("amount" BETWEEN 1 AND 100000000),
    CONSTRAINT "charges_owner_check" CHECK ("application_id" IS NOT NULL OR "enrollment_id" IS NOT NULL),
    CONSTRAINT "charges_month_check" CHECK (("kind" = 'PROPINA') = ("month" IS NOT NULL)),
    CONSTRAINT "charges_waive_check" CHECK ("status" <> 'WAIVED' OR char_length("waive_reason") >= 3),
    CONSTRAINT "charges_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT,
    CONSTRAINT "charges_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT,
    CONSTRAINT "charges_application_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT,
    CONSTRAINT "charges_enrollment_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT,
    CONSTRAINT "charges_fee_fkey" FOREIGN KEY ("fee_item_id") REFERENCES "fee_items"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "charges_application_key" ON "charges"("application_id", "fee_item_id", "kind") WHERE "application_id" IS NOT NULL AND "kind" IN ('INSCRICAO', 'MATRICULA');
CREATE UNIQUE INDEX "charges_enrollment_key" ON "charges"("enrollment_id", "fee_item_id", coalesce("month", '')) WHERE "enrollment_id" IS NOT NULL AND "kind" IN ('PROPINA', 'OUTRA');
CREATE INDEX "charges_student_idx" ON "charges"("student_id", "status");
CREATE INDEX "charges_status_idx" ON "charges"("status", "due_on");

CREATE SEQUENCE "payment_number_seq";
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL DEFAULT nextval('payment_number_seq'),
    -- conta da família (null: registado pelas Finanças para uma família sem conta)
    "account_id" UUID,
    "payer_name" TEXT NOT NULL,
    -- TRANSFERENCIA | DEPOSITO
    "method" TEXT NOT NULL,
    "bank_account_id" UUID,
    -- cópia das coordenadas na altura do pagamento
    "bank_name" TEXT NOT NULL,
    "bank_iban" TEXT NOT NULL,
    "transaction_number" TEXT NOT NULL,
    "paid_on" DATE NOT NULL,
    "total" INTEGER NOT NULL,
    "note" TEXT,
    "proof_name" TEXT NOT NULL,
    "proof_mime_type" TEXT NOT NULL,
    "proof_size" INTEGER NOT NULL,
    "proof_sha256" TEXT NOT NULL,
    "proof_storage_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    -- FAMILY | STAFF
    "created_by_kind" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "overdue_notified_at" TIMESTAMP(3),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payments_method_check" CHECK ("method" IN ('TRANSFERENCIA', 'DEPOSITO')),
    CONSTRAINT "payments_status_check" CHECK ("status" IN ('SUBMITTED', 'VALIDATED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "payments_total_check" CHECK ("total" > 0),
    CONSTRAINT "payments_reject_check" CHECK ("status" <> 'REJECTED' OR char_length("decision_note") >= 3),
    CONSTRAINT "payments_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE SET NULL,
    CONSTRAINT "payments_bank_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE SET NULL
);
ALTER SEQUENCE "payment_number_seq" OWNED BY "payments"."number";
CREATE UNIQUE INDEX "payments_number_key" ON "payments"("number");
-- o mesmo n.º de transação não serve para dois pagamentos (salvo recusados ou retirados)
CREATE UNIQUE INDEX "payments_transaction_key" ON "payments"("bank_iban", upper("transaction_number")) WHERE "status" IN ('SUBMITTED', 'VALIDATED');
CREATE INDEX "payments_status_idx" ON "payments"("status", "submitted_at");
CREATE INDEX "payments_account_idx" ON "payments"("account_id", "submitted_at");

CREATE TABLE "payment_items" (
    "payment_id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "late_fee" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "payment_items_pkey" PRIMARY KEY ("payment_id", "charge_id"),
    CONSTRAINT "payment_items_payment_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE,
    CONSTRAINT "payment_items_charge_fkey" FOREIGN KEY ("charge_id") REFERENCES "charges"("id") ON DELETE RESTRICT,
    CONSTRAINT "payment_items_amount_check" CHECK ("amount" > 0 AND "late_fee" >= 0)
);
CREATE INDEX "payment_items_charge_idx" ON "payment_items"("charge_id");
