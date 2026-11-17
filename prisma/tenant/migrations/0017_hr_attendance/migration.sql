-- =============================================================================
--  RECURSOS HUMANOS — assiduidade dos funcionários
--
--  employee_attendance   um registo por funcionário e por dia, marcado pelo RH:
--                          PRESENTE · ATRASO (minutos) · FALTA · FALTA_JUSTIFICADA (motivo)
--                        Sem registo = por marcar. Comprovativo opcional (atraso e faltas),
--                        cifrado no armazenamento do RH do colégio; aqui só a chave interna,
--                        o nome, o tipo e o tamanho.
-- =============================================================================
CREATE TABLE "employee_attendance" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    -- PRESENTE | ATRASO | FALTA | FALTA_JUSTIFICADA
    "status" TEXT NOT NULL,
    "minutes_late" INTEGER,
    "note" TEXT,
    "proof_name" TEXT,
    "proof_mime_type" TEXT,
    "proof_size" INTEGER,
    "proof_sha256" TEXT,
    "proof_storage_key" TEXT,
    "proof_uploaded_at" TIMESTAMP(3),
    "recorded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_attendance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_attendance_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "employee_attendance_status_check" CHECK ("status" IN ('PRESENTE', 'ATRASO', 'FALTA', 'FALTA_JUSTIFICADA')),
    -- atraso: sempre com os minutos (1 a 600); os outros sem minutos
    CONSTRAINT "employee_attendance_late_check" CHECK ((("status" = 'ATRASO') = ("minutes_late" IS NOT NULL)) AND ("minutes_late" IS NULL OR "minutes_late" BETWEEN 1 AND 600)),
    -- falta justificada: sempre com o motivo
    CONSTRAINT "employee_attendance_note_check" CHECK (char_length(coalesce("note", '')) <= 300 AND ("status" <> 'FALTA_JUSTIFICADA' OR char_length(coalesce("note", '')) >= 3)),
    -- comprovativo: nunca numa presença
    CONSTRAINT "employee_attendance_proof_check" CHECK ((("proof_storage_key" IS NULL) = ("proof_name" IS NULL)) AND ("proof_storage_key" IS NULL OR "status" <> 'PRESENTE') AND ("proof_size" IS NULL OR "proof_size" BETWEEN 1 AND 10485760))
);
CREATE UNIQUE INDEX "employee_attendance_employee_day_key" ON "employee_attendance"("employee_id", "day");
CREATE INDEX "employee_attendance_day_idx" ON "employee_attendance"("day");
