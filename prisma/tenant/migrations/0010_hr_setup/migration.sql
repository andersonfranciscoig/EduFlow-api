-- =============================================================================
--  RECURSOS HUMANOS — permissões e configuração do cadastro de funcionários
--
--  school_user_permissions  permissões granulares por utilizador (independentes do
--                           papel). O responsável do colégio tem todas, sem linhas aqui.
--  hr_form_sections         secções configuráveis do cadastro (formação académica,
--                           dados profissionais): título, se é repetível, limite.
--  hr_form_fields           campos que cada colégio escolhe pedir em cada secção.
--  hr_document_types        documentos que o colégio pede (formatos, tamanho, …).
--  hr_form_versions         versões PUBLICADAS da configuração (fotografia em JSON).
--                           Cada cadastro fica ligado à versão com que começou:
--                           alterar a configuração não mexe nos cadastros em curso.
--
--  Os dados pessoais (nome, BI, NIF, …) são fixos e iguais em todos os colégios:
--  vivem no código (e na fotografia de cada versão), não nestas tabelas.
-- =============================================================================
CREATE TABLE "school_user_permissions" (
    "user_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "granted_by_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_user_permissions_pkey" PRIMARY KEY ("user_id", "permission"),
    CONSTRAINT "school_user_permissions_user_fkey" FOREIGN KEY ("user_id") REFERENCES "school_users"("id") ON DELETE CASCADE,
    CONSTRAINT "school_user_permissions_check" CHECK ("permission" ~ '^[a-z_]+(\.[a-z_]+)+$')
);
CREATE INDEX "school_user_permissions_permission_idx" ON "school_user_permissions"("permission");

CREATE TABLE "hr_form_sections" (
    -- ACADEMIC | PROFESSIONAL
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    -- o funcionário pode juntar vários registos (ex.: várias formações)
    "repeatable" BOOLEAN NOT NULL DEFAULT false,
    -- nome de cada registo (ex.: "Formação", "Experiência")
    "entry_label" TEXT NOT NULL,
    "max_entries" INTEGER NOT NULL DEFAULT 10,
    "position" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hr_form_sections_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "hr_form_sections_key_check" CHECK ("key" IN ('ACADEMIC', 'PROFESSIONAL')),
    CONSTRAINT "hr_form_sections_title_check" CHECK (char_length("title") BETWEEN 2 AND 60),
    CONSTRAINT "hr_form_sections_entry_check" CHECK (char_length("entry_label") BETWEEN 2 AND 40),
    CONSTRAINT "hr_form_sections_max_check" CHECK ("max_entries" BETWEEN 1 AND 20)
);
INSERT INTO "hr_form_sections" ("key", "title", "description", "repeatable", "entry_label", "max_entries", "position", "updated_at") VALUES
    ('ACADEMIC', 'Formação académica', 'Habilitações e formações do funcionário.', true, 'Formação', 10, 1, CURRENT_TIMESTAMP),
    ('PROFESSIONAL', 'Dados profissionais', 'Cargo, vínculo e experiência profissional.', false, 'Registo', 10, 2, CURRENT_TIMESTAMP);

CREATE TABLE "hr_form_fields" (
    "id" UUID NOT NULL,
    "section" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    -- TEXT | LONG_TEXT | NUMBER | DATE | EMAIL | PHONE | SELECT | MULTI_SELECT | BOOLEAN | FILE
    "type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "help" TEXT,
    -- opções (seleção) e regras do tipo (ex.: formatos e tamanho de um ficheiro)
    "options" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hr_form_fields_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hr_form_fields_section_fkey" FOREIGN KEY ("section") REFERENCES "hr_form_sections"("key") ON DELETE RESTRICT,
    CONSTRAINT "hr_form_fields_label_check" CHECK (char_length("label") BETWEEN 2 AND 80),
    CONSTRAINT "hr_form_fields_help_check" CHECK ("help" IS NULL OR char_length("help") <= 240),
    CONSTRAINT "hr_form_fields_type_check" CHECK ("type" IN ('TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'EMAIL', 'PHONE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN', 'FILE'))
);
-- o mesmo nome não se repete dentro de uma secção
CREATE UNIQUE INDEX "hr_form_fields_section_label_key" ON "hr_form_fields"("section", lower("label"));
CREATE INDEX "hr_form_fields_section_idx" ON "hr_form_fields"("section", "position");

CREATE TABLE "hr_document_types" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    -- extensões permitidas: pdf, jpg, png, webp, doc, docx
    "formats" TEXT[] NOT NULL,
    "max_size_mb" INTEGER NOT NULL DEFAULT 5,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hr_document_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hr_document_types_name_check" CHECK (char_length("name") BETWEEN 2 AND 80),
    CONSTRAINT "hr_document_types_description_check" CHECK ("description" IS NULL OR char_length("description") <= 240),
    CONSTRAINT "hr_document_types_formats_check" CHECK (cardinality("formats") >= 1 AND "formats" <@ ARRAY['pdf', 'jpg', 'png', 'webp', 'doc', 'docx']),
    CONSTRAINT "hr_document_types_size_check" CHECK ("max_size_mb" BETWEEN 1 AND 20)
);
CREATE UNIQUE INDEX "hr_document_types_name_key" ON "hr_document_types"(lower("name"));

CREATE TABLE "hr_form_versions" (
    "id" UUID NOT NULL,
    -- 1, 2, 3… (única no colégio)
    "number" INTEGER NOT NULL,
    -- fotografia: dados pessoais + secções com os campos ativos + documentos ativos
    "snapshot" JSONB NOT NULL,
    "published_by_id" UUID,
    "published_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hr_form_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hr_form_versions_number_check" CHECK ("number" >= 1)
);
CREATE UNIQUE INDEX "hr_form_versions_number_key" ON "hr_form_versions"("number");
