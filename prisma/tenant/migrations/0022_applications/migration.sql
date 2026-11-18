-- =============================================================================
--  INSCRIÇÕES (processos) — fase C: a família preenche e submete.
--  applications          o processo de inscrição de um aluno, feito por uma conta de família
--                        (o encarregado, para um educando menor; ou o próprio aluno maior).
--                        Fica preso à versão do formulário com que começou (form_version).
--                        Os dados ficam em JSONB por parte (aluno, encarregado, secções do colégio).
--                        version: controlo de alterações concorrentes (duas janelas abertas).
--                        number: n.º do processo, dado na submissão (ex.: INS-2026-00001).
--  application_files     ficheiros entregues (cifrados no armazenamento do colégio; aqui só a chave).
--  application_history   mudanças de estado (quem, quando, de → para, justificação).
-- =============================================================================
CREATE SEQUENCE "application_number_seq" START 1;

CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "number" TEXT,
    "account_id" UUID NOT NULL,
    "student_id" UUID,
    "process_type" TEXT NOT NULL,
    "form_version" INTEGER NOT NULL,
    "academic_year_id" UUID,
    "class_id" UUID,
    "shift" TEXT,
    "student_data" JSONB NOT NULL DEFAULT '{}',
    "guardian_data" JSONB NOT NULL DEFAULT '{}',
    "sections_data" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "current_step" TEXT NOT NULL DEFAULT 'candidatura',
    "version" INTEGER NOT NULL DEFAULT 1,
    "terms_accepted_at" TIMESTAMP(3),
    "legitimacy_declared" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "applications_process_check" CHECK ("process_type" IN ('NOVA', 'RENOVACAO', 'TRANSFERENCIA', 'REINGRESSO')),
    CONSTRAINT "applications_status_check" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "applications_shift_check" CHECK ("shift" IS NULL OR "shift" IN ('MANHA', 'TARDE', 'NOITE')),
    -- submetido ⇒ tem número, ano, classe e data
    CONSTRAINT "applications_submitted_check" CHECK ("status" = 'DRAFT' OR ("number" IS NOT NULL AND "academic_year_id" IS NOT NULL AND "class_id" IS NOT NULL AND "submitted_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "applications_number_key" ON "applications"("number");
CREATE INDEX "applications_account_idx" ON "applications"("account_id", "created_at");
CREATE INDEX "applications_year_status_idx" ON "applications"("academic_year_id", "status");
ALTER TABLE "applications" ADD CONSTRAINT "applications_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "applications" ADD CONSTRAINT "applications_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "application_files" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "item_id" TEXT,
    "label" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "application_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "application_files_slot_check" CHECK ("slot" IN ('PHOTO', 'DOCUMENT', 'FIELD'))
);
CREATE INDEX "application_files_app_idx" ON "application_files"("application_id", "slot", "created_at");
ALTER TABLE "application_files" ADD CONSTRAINT "application_files_app_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "application_history" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    -- FAMILY (conta de família) | STAFF (equipa do colégio)
    "actor_kind" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "application_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "application_history_actor_check" CHECK ("actor_kind" IN ('FAMILY', 'STAFF'))
);
CREATE INDEX "application_history_app_idx" ON "application_history"("application_id", "created_at");
ALTER TABLE "application_history" ADD CONSTRAINT "application_history_app_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
