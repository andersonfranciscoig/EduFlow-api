-- =============================================================================
--  JUSTIFICAÇÕES DAS FALTAS DOS PROFESSORES — fase P4.
--
--  occurrence_justifications   o professor justifica uma falta/atraso (registada pelo RH ou
--                              automática): motivo e, opcional, um comprovativo (PDF/JPG/PNG,
--                              cifrado no armazenamento do RH do colégio; aqui só a chave interna).
--                              PENDING → APPROVED (a ocorrência fica justificada) · REJECTED (com
--                              a nota do RH; o professor pode voltar a justificar).
--                              Uma pendente de cada vez por ocorrência.
-- =============================================================================
CREATE TABLE "occurrence_justifications" (
    "id" UUID NOT NULL,
    "occurrence_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "proof_name" TEXT,
    "proof_mime_type" TEXT,
    "proof_size" INTEGER,
    "proof_sha256" TEXT,
    "proof_storage_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decision_note" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "occurrence_justifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "occurrence_justifications_occurrence_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "teacher_occurrences"("id") ON DELETE CASCADE,
    CONSTRAINT "occurrence_justifications_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "occurrence_justifications_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT "occurrence_justifications_reason_check" CHECK (char_length("reason") BETWEEN 3 AND 500),
    CONSTRAINT "occurrence_justifications_note_check" CHECK (char_length(coalesce("decision_note", '')) <= 300),
    CONSTRAINT "occurrence_justifications_proof_check" CHECK ((("proof_storage_key" IS NULL) = ("proof_name" IS NULL)) AND ("proof_size" IS NULL OR "proof_size" BETWEEN 1 AND 10485760))
);
CREATE UNIQUE INDEX "occurrence_justifications_pending_key" ON "occurrence_justifications"("occurrence_id") WHERE "status" = 'PENDING';
CREATE INDEX "occurrence_justifications_status_idx" ON "occurrence_justifications"("status", "created_at");
CREATE INDEX "occurrence_justifications_employee_idx" ON "occurrence_justifications"("employee_id", "created_at");
