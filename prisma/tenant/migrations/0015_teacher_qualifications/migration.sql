-- =============================================================================
--  HABILITAÇÕES DOS PROFESSORES — o que cada professor pode lecionar:
--  tipo de ensino → classes (e cursos, no II Ciclo) → disciplinas.
--  Um professor pode ter várias habilitações (ex.: uma no I Ciclo, outra no II Ciclo).
--  Serve para a atribuição (manual e automática) dos professores às turmas.
-- =============================================================================
CREATE TABLE "teacher_qualifications" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    -- pre | primario | ciclo1 | ciclo2
    "level" TEXT NOT NULL,
    -- classes (0 = Iniciação … 13)
    "grades" INTEGER[] NOT NULL,
    -- só no II Ciclo: cursos do catálogo
    "course_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "subject_ids" UUID[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "teacher_qualifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "teacher_qualifications_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "teacher_qualifications_level_check" CHECK ("level" IN ('pre', 'primario', 'ciclo1', 'ciclo2')),
    CONSTRAINT "teacher_qualifications_grades_check" CHECK (cardinality("grades") BETWEEN 1 AND 14),
    CONSTRAINT "teacher_qualifications_subjects_check" CHECK (cardinality("subject_ids") BETWEEN 1 AND 60)
);
CREATE INDEX "teacher_qualifications_employee_idx" ON "teacher_qualifications"("employee_id");
