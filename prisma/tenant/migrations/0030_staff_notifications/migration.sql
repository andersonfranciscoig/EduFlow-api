-- =============================================================================
--  NOTIFICAÇÕES DA EQUIPA + ENTREGAS + TIPOS + PREFERÊNCIAS — fase P2.
--
--  staff_notifications        caixa de cada utilizador do portal (direção, secretaria, RH,
--                             professores). dedupe_key evita o mesmo aviso duas vezes.
--  notification_deliveries    histórico de envios (equipa e família): por canal (na plataforma,
--                             email), destinatário, estado (enviado, falhou, não enviado) e erro.
--  notification_types         o colégio liga/desliga cada tipo e escolhe se também vai por email
--                             (sem linha = valores por omissão do catálogo).
--  notification_preferences   cada pessoa da equipa escolhe se quer o email de cada tipo
--                             (sem linha = recebe, se o colégio o enviar por email).
--  As notificações da família continuam em family_notifications (fase H).
-- =============================================================================
CREATE TABLE "staff_notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "staff_notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_notifications_user_fkey" FOREIGN KEY ("user_id") REFERENCES "school_users"("id") ON DELETE CASCADE,
    CONSTRAINT "staff_notifications_text_check" CHECK (char_length("title") BETWEEN 1 AND 200 AND char_length(coalesce("body", '')) <= 1000)
);
CREATE INDEX "staff_notifications_user_idx" ON "staff_notifications"("user_id", "created_at" DESC);
CREATE INDEX "staff_notifications_unread_idx" ON "staff_notifications"("user_id") WHERE "read_at" IS NULL;
CREATE UNIQUE INDEX "staff_notifications_dedupe_key" ON "staff_notifications"("user_id", "dedupe_key") WHERE "dedupe_key" IS NOT NULL;

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    -- STAFF | FAMILY
    "audience" TEXT NOT NULL,
    "notification_id" UUID,
    "recipient_id" UUID NOT NULL,
    "recipient_name" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    -- IN_APP | EMAIL
    "channel" TEXT NOT NULL,
    "destination" TEXT,
    -- SENT | FAILED | SKIPPED
    "status" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_audience_check" CHECK ("audience" IN ('STAFF', 'FAMILY')),
    CONSTRAINT "notification_deliveries_channel_check" CHECK ("channel" IN ('IN_APP', 'EMAIL')),
    CONSTRAINT "notification_deliveries_status_check" CHECK ("status" IN ('SENT', 'FAILED', 'SKIPPED'))
);
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries"("created_at" DESC);
CREATE INDEX "notification_deliveries_filter_idx" ON "notification_deliveries"("kind", "status", "channel");

CREATE TABLE "notification_types" (
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_types_pkey" PRIMARY KEY ("kind")
);

CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id", "kind"),
    CONSTRAINT "notification_preferences_user_fkey" FOREIGN KEY ("user_id") REFERENCES "school_users"("id") ON DELETE CASCADE
);
