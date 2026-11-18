-- =============================================================================
--  SECRETARIA — inscrições e matrículas: configuração (1.ª parte)
--
--  admission_periods         por ano letivo, quando estão abertas as inscrições, as
--                            matrículas e as renovações (cada par: as duas datas ou nenhuma).
--  admission_document_types  documentos pedidos: a quem (aluno, encarregado ou ambos), em
--                            que processos (nova inscrição, renovação, transferência,
--                            reingresso — vazio = todos), formatos, tamanho, n.º de ficheiros
--                            e se se pede a data de validade.
-- =============================================================================
CREATE TABLE "admission_periods" (
    "academic_year_id" UUID NOT NULL,
    "applications_from" DATE,
    "applications_to" DATE,
    "enrollments_from" DATE,
    "enrollments_to" DATE,
    "renewals_from" DATE,
    "renewals_to" DATE,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_periods_pkey" PRIMARY KEY ("academic_year_id"),
    CONSTRAINT "admission_periods_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "admission_periods_applications_check" CHECK ((("applications_from" IS NULL) = ("applications_to" IS NULL)) AND ("applications_from" IS NULL OR "applications_from" <= "applications_to")),
    CONSTRAINT "admission_periods_enrollments_check" CHECK ((("enrollments_from" IS NULL) = ("enrollments_to" IS NULL)) AND ("enrollments_from" IS NULL OR "enrollments_from" <= "enrollments_to")),
    CONSTRAINT "admission_periods_renewals_check" CHECK ((("renewals_from" IS NULL) = ("renewals_to" IS NULL)) AND ("renewals_from" IS NULL OR "renewals_from" <= "renewals_to"))
);

CREATE TABLE "admission_document_types" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    -- STUDENT | GUARDIAN | BOTH
    "target" TEXT NOT NULL,
    -- NOVA | RENOVACAO | TRANSFERENCIA | REINGRESSO (vazio = todos)
    "process_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "formats" TEXT[] NOT NULL,
    "max_size_mb" INTEGER NOT NULL DEFAULT 5,
    "max_files" INTEGER NOT NULL DEFAULT 1,
    "needs_expiry" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_document_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admission_document_types_name_check" CHECK (char_length("name") BETWEEN 2 AND 80 AND char_length(coalesce("description", '')) <= 240),
    CONSTRAINT "admission_document_types_target_check" CHECK ("target" IN ('STUDENT', 'GUARDIAN', 'BOTH')),
    CONSTRAINT "admission_document_types_process_check" CHECK ("process_types" <@ ARRAY['NOVA', 'RENOVACAO', 'TRANSFERENCIA', 'REINGRESSO']::TEXT[]),
    CONSTRAINT "admission_document_types_formats_check" CHECK (cardinality("formats") BETWEEN 1 AND 6 AND "formats" <@ ARRAY['pdf', 'jpg', 'png', 'webp', 'doc', 'docx']::TEXT[]),
    CONSTRAINT "admission_document_types_size_check" CHECK ("max_size_mb" BETWEEN 1 AND 20 AND "max_files" BETWEEN 1 AND 10)
);
CREATE UNIQUE INDEX "admission_document_types_name_key" ON "admission_document_types"(lower("name"));
