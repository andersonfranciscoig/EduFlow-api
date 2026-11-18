-- =============================================================================
--  SECRETARIA — inscrições e matrículas: formulários (configuração, 2.ª parte)
--
--  admission_fixed_fields    o modo (obrigatório / opcional / não pedir) dos dados fixos do
--                            aluno e do encarregado que o colégio pode mudar. Os campos e os
--                            essenciais vêm do código; aqui só ficam as escolhas do colégio.
--  admission_form_sections   secções do colégio (ex.: percurso escolar anterior), repetíveis
--                            ou não, e em que processos aparecem (vazio = todos).
--  admission_form_fields     campos de cada secção (10 tipos), processos, e a condição: só
--                            aparecem quando um campo anterior da secção tem certos valores.
--  admission_form_versions   versões publicadas: fotografia em JSON dos dados fixos, secções e
--                            documentos. Cada inscrição fica presa à versão com que começou.
-- =============================================================================
CREATE TABLE "admission_fixed_fields" (
    -- STUDENT | GUARDIAN
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    -- REQUIRED | OPTIONAL | HIDDEN
    "mode" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_fixed_fields_pkey" PRIMARY KEY ("scope", "key"),
    CONSTRAINT "admission_fixed_fields_scope_check" CHECK ("scope" IN ('STUDENT', 'GUARDIAN')),
    CONSTRAINT "admission_fixed_fields_mode_check" CHECK ("mode" IN ('REQUIRED', 'OPTIONAL', 'HIDDEN'))
);

CREATE TABLE "admission_form_sections" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    "entry_label" TEXT NOT NULL DEFAULT 'Registo',
    "max_entries" INTEGER NOT NULL DEFAULT 1,
    "process_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_form_sections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admission_form_sections_title_check" CHECK (char_length("title") BETWEEN 2 AND 60 AND char_length(coalesce("description", '')) <= 240),
    CONSTRAINT "admission_form_sections_entries_check" CHECK ("max_entries" BETWEEN 1 AND 20 AND char_length("entry_label") BETWEEN 2 AND 40),
    CONSTRAINT "admission_form_sections_process_check" CHECK ("process_types" <@ ARRAY['NOVA', 'RENOVACAO', 'TRANSFERENCIA', 'REINGRESSO']::TEXT[])
);
CREATE UNIQUE INDEX "admission_form_sections_title_key" ON "admission_form_sections"(lower("title"));

CREATE TABLE "admission_form_fields" (
    "id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    -- TEXT | LONG_TEXT | NUMBER | DATE | EMAIL | PHONE | SELECT | MULTI_SELECT | BOOLEAN | FILE
    "type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "help" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "process_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- { fieldId, values[] } — mostrar só quando o campo anterior tem um destes valores
    "condition" JSONB,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_form_fields_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admission_form_fields_section_fkey" FOREIGN KEY ("section_id") REFERENCES "admission_form_sections"("id") ON DELETE CASCADE,
    CONSTRAINT "admission_form_fields_label_check" CHECK (char_length("label") BETWEEN 2 AND 80 AND char_length(coalesce("help", '')) <= 240),
    CONSTRAINT "admission_form_fields_type_check" CHECK ("type" IN ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'EMAIL', 'PHONE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN', 'FILE')),
    CONSTRAINT "admission_form_fields_process_check" CHECK ("process_types" <@ ARRAY['NOVA', 'RENOVACAO', 'TRANSFERENCIA', 'REINGRESSO']::TEXT[])
);
CREATE INDEX "admission_form_fields_section_idx" ON "admission_form_fields"("section_id", "position");

CREATE TABLE "admission_form_versions" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "published_by_id" UUID,
    "published_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_form_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admission_form_versions_number_check" CHECK ("number" > 0)
);
CREATE UNIQUE INDEX "admission_form_versions_number_key" ON "admission_form_versions"("number");
