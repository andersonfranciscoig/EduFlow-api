-- =============================================================================
--  Fase H — área da família
--  family_notifications   avisos dentro da aplicação (correções pedidas, aprovada, rejeitada,
--                         matrícula confirmada, conta passada ao aluno…); lidos/por ler
--  student_handovers      o encarregado convida o educando que fez 18 anos a gerir a própria
--                         conta: quando o aluno cria/entra com a conta de aluno maior com esse
--                         email (e a mesma data de nascimento), o registo passa a ser dele
-- =============================================================================
CREATE TABLE "family_notifications" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "student_id" UUID,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "family_notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_notifications_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "family_notifications_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "family_notifications_account_idx" ON "family_notifications"("account_id", "created_at" DESC);
CREATE INDEX "family_notifications_unread_idx" ON "family_notifications"("account_id") WHERE "read_at" IS NULL;

CREATE TABLE "student_handovers" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "created_by_id" UUID,
    -- PENDING | DONE | CANCELLED
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "account_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "student_handovers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_handovers_status_check" CHECK ("status" IN ('PENDING', 'DONE', 'CANCELLED')),
    CONSTRAINT "student_handovers_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "student_handovers_creator_fkey" FOREIGN KEY ("created_by_id") REFERENCES "family_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "student_handovers_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- um convite por aluno de cada vez
CREATE UNIQUE INDEX "student_handovers_pending_key" ON "student_handovers"("student_id") WHERE "status" = 'PENDING';
CREATE INDEX "student_handovers_email_idx" ON "student_handovers"("email") WHERE "status" = 'PENDING';
