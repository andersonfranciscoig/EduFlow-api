-- =============================================================================
--  PREÇÁRIO (Finanças)
--
--  fee_items     rubricas de cobrança do colégio (atravessam os anos):
--                Propina (mensal), Matrícula, Confirmação, Uniforme…
--  class_fees    preço de cada rubrica em cada classe do ano letivo.
--                A classe do II Ciclo já é uma por curso (10.ª · CFB, 10.ª · CEJ…),
--                por isso "preço por curso" é o preço dessa classe.
--  fee_plans     calendário das propinas do ano: meses cobrados, dia limite
--                e multa por atraso (opcional).
--
--  Valores em kwanzas (inteiros). As cobranças aos alunos (mais tarde) copiam
--  o valor do momento: mudar o preçário não altera o que já foi cobrado.
-- =============================================================================
CREATE TABLE "fee_items" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- MENSAL (uma vez por mês cobrado) | UNICA (uma vez no ano)
    "billing" TEXT NOT NULL,
    -- quem paga: TODOS | NOVOS (alunos novos) | CONTINUANTES (já eram do colégio)
    "applies_to" TEXT NOT NULL DEFAULT 'TODOS',
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fee_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fee_items_name_check" CHECK (char_length("name") BETWEEN 2 AND 40),
    CONSTRAINT "fee_items_billing_check" CHECK ("billing" IN ('MENSAL', 'UNICA')),
    CONSTRAINT "fee_items_applies_check" CHECK ("applies_to" IN ('TODOS', 'NOVOS', 'CONTINUANTES'))
);
CREATE UNIQUE INDEX "fee_items_name_key" ON "fee_items"(lower("name"));

-- rubricas de partida (o colégio muda o nome, arquiva ou acrescenta)
INSERT INTO "fee_items" ("id", "name", "billing", "applies_to", "position", "created_at", "updated_at") VALUES
    (gen_random_uuid(), 'Propina', 'MENSAL', 'TODOS', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Matrícula', 'UNICA', 'NOVOS', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Confirmação', 'UNICA', 'CONTINUANTES', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE "class_fees" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "fee_item_id" UUID NOT NULL,
    -- kwanzas
    "amount" INTEGER NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "class_fees_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "class_fees_amount_check" CHECK ("amount" BETWEEN 0 AND 100000000),
    CONSTRAINT "class_fees_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "class_fees_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE CASCADE,
    CONSTRAINT "class_fees_item_fkey" FOREIGN KEY ("fee_item_id") REFERENCES "fee_items"("id") ON DELETE RESTRICT
);
-- uma classe, uma rubrica → um preço
CREATE UNIQUE INDEX "class_fees_class_item_key" ON "class_fees"("class_id", "fee_item_id");
CREATE INDEX "class_fees_year_idx" ON "class_fees"("academic_year_id");
CREATE INDEX "class_fees_item_idx" ON "class_fees"("fee_item_id");

CREATE TABLE "fee_plans" (
    "academic_year_id" UUID NOT NULL,
    -- meses cobrados, por ordem: ["2026-09", "2026-10", …]
    "months" JSONB NOT NULL,
    -- pagar até ao dia N de cada mês
    "due_day" INTEGER NOT NULL DEFAULT 10,
    -- multa por atraso: NONE | PERCENT (% da propina) | FIXED (kwanzas)
    "late_fee_kind" TEXT NOT NULL DEFAULT 'NONE',
    "late_fee_value" INTEGER NOT NULL DEFAULT 0,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fee_plans_pkey" PRIMARY KEY ("academic_year_id"),
    CONSTRAINT "fee_plans_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "fee_plans_due_day_check" CHECK ("due_day" BETWEEN 1 AND 28),
    CONSTRAINT "fee_plans_late_kind_check" CHECK ("late_fee_kind" IN ('NONE', 'PERCENT', 'FIXED')),
    CONSTRAINT "fee_plans_late_value_check" CHECK (
        ("late_fee_kind" = 'NONE' AND "late_fee_value" = 0)
        OR ("late_fee_kind" = 'PERCENT' AND "late_fee_value" BETWEEN 1 AND 100)
        OR ("late_fee_kind" = 'FIXED' AND "late_fee_value" BETWEEN 1 AND 10000000)
    )
);
