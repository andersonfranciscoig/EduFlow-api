-- =============================================================================
--  Armazenamento de ficheiros de cada colégio: a SUA app do UploadThing.
--  O token nunca fica em claro:
--    token_sealed      selado com a chave PÚBLICA das credenciais dos colégios — só o
--                      school-api (que tem a privada) o abre, para enviar/ler ficheiros;
--    token_ciphertext  cifrado (AES-256-GCM) com uma chave só da plataforma — para a
--                      equipa consultar o uso (bytes, limite, plano).
--  O resto é o último uso medido (o painel mostra-o; atualiza-se a pedido).
-- =============================================================================
CREATE TABLE "school_storage" (
    "school_id" UUID NOT NULL,
    -- UPLOADTHING (o único, por agora)
    "provider" TEXT NOT NULL DEFAULT 'UPLOADTHING',
    "app_id" TEXT NOT NULL,
    -- últimos caracteres da chave (para reconhecer qual está configurada)
    "key_hint" TEXT NOT NULL,
    "token_sealed" TEXT NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    -- FREE | PAID | UNKNOWN (deduzido do limite da conta)
    "plan" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "used_bytes" BIGINT,
    "app_bytes" BIGINT,
    "limit_bytes" BIGINT,
    "files_count" INTEGER,
    "usage_checked_at" TIMESTAMP(3),
    "usage_error" TEXT,
    "configured_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_storage_pkey" PRIMARY KEY ("school_id"),
    CONSTRAINT "school_storage_school_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE,
    CONSTRAINT "school_storage_provider_check" CHECK ("provider" IN ('UPLOADTHING')),
    CONSTRAINT "school_storage_plan_check" CHECK ("plan" IN ('FREE', 'PAID', 'UNKNOWN'))
);
-- a mesma app do UploadThing não serve dois colégios
CREATE UNIQUE INDEX "school_storage_app_key" ON "school_storage"("app_id");
