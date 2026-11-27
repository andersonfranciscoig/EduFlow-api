-- DOCUMENTOS: o cabeçalho oficial dos documentos emitidos (uma linha por colégio), como nos
-- documentos escolares angolanos: a insígnia da República ao centro, "REPÚBLICA DE ANGOLA",
-- o ministério e o nome do colégio (o logótipo do colégio fica à esquerda, conforme o modelo).
--   enabled        o colégio pode retirar o cabeçalho oficial (fica só o logótipo e o nome)
--   ministry_line  editável (ex.: "Ministério da Educação"); vazio = sem esta linha
--   emblem_*       a insígnia carregada pelo colégio (PNG ou JPG, cifrada no armazenamento do colégio)

CREATE TABLE "document_header_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "country_line" TEXT NOT NULL DEFAULT 'República de Angola',
    "ministry_line" TEXT DEFAULT 'Ministério da Educação',
    "show_emblem" BOOLEAN NOT NULL DEFAULT true,
    "emblem_key" TEXT,
    "emblem_name" TEXT,
    "emblem_mime" TEXT,
    "emblem_sha256" TEXT,
    "emblem_uploaded_at" TIMESTAMP(3),
    -- o logótipo dos documentos e cartões (PNG ou JPG), quando o da plataforma não se imprime (ex.: WEBP)
    -- ou o colégio quer outro; sem ele usa-se o logótipo do colégio na plataforma
    "logo_key" TEXT,
    "logo_name" TEXT,
    "logo_mime" TEXT,
    "logo_sha256" TEXT,
    "logo_uploaded_at" TIMESTAMP(3),
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3),
    CONSTRAINT "document_header_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_header_settings_single_check" CHECK ("id" = 1),
    CONSTRAINT "document_header_settings_emblem_mime_check" CHECK ("emblem_mime" IS NULL OR "emblem_mime" IN ('image/png', 'image/jpeg')),
    CONSTRAINT "document_header_settings_logo_mime_check" CHECK ("logo_mime" IS NULL OR "logo_mime" IN ('image/png', 'image/jpeg'))
);
