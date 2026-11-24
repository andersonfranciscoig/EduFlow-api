-- =============================================================================
--  RESUMOS DIÁRIOS — fase P6.
--
--  daily_digests   um resumo por pessoa e por dia de aulas (o índice único garante-o):
--                  STAFF   professor e/ou coordenador de turma (recipient_id = school_users.id)
--                  FAMILY  encarregado (educandos menores que gere) ou aluno maior com conta
--                          (recipient_id = family_accounts.id)
--                  due_at  hora local do colégio em que ficou devido: 1 h depois da última aula
--                          prevista dessa pessoa nesse dia.
--                  content o resumo tal como foi enviado. O aviso em si vai para a caixa
--                          (staff_notifications / family_notifications) e fica no histórico de envios.
--                  email_state (só FAMILY; o email da equipa sai com o aviso): NONE | PENDING |
--                          SENT | FAILED — o que ficou PENDING volta a ser tentado (até 3 vezes).
--  family_notification_preferences   a conta da família pode recusar o email de um tipo
--                  (sem linha = recebe, se o colégio o enviar por email).
-- =============================================================================
CREATE TABLE "daily_digests" (
    "id" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "recipient_id" UUID NOT NULL,
    "recipient_name" TEXT,
    "day" DATE NOT NULL,
    "due_at" TIMESTAMP(0) NOT NULL,
    "headline" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "email_state" TEXT NOT NULL DEFAULT 'NONE',
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "daily_digests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "daily_digests_audience_check" CHECK ("audience" IN ('STAFF', 'FAMILY')),
    CONSTRAINT "daily_digests_email_check" CHECK ("email_state" IN ('NONE', 'PENDING', 'SENT', 'FAILED'))
);
CREATE UNIQUE INDEX "daily_digests_recipient_day_key" ON "daily_digests"("audience", "recipient_id", "day");
CREATE INDEX "daily_digests_day_idx" ON "daily_digests"("day");
CREATE INDEX "daily_digests_email_idx" ON "daily_digests"("created_at") WHERE "email_state" = 'PENDING';

CREATE TABLE "family_notification_preferences" (
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "email" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "family_notification_preferences_pkey" PRIMARY KEY ("account_id", "kind"),
    CONSTRAINT "family_notification_preferences_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE CASCADE
);
