-- =============================================================================
--  PRAZO DAS PRESENÇAS, AULAS PENDENTES, SUBSTITUIÇÕES E TAREFAS AUTOMÁTICAS — fase P3.
--
--  attendance_settings.tracking_since   a partir de que dia o controlo automático conta
--                                        (por omissão: o dia em que o módulo chegou ao colégio).
--  lesson_substitutions   um professor substitui outro numa aula, num dia (o substituto regista
--                         as presenças; é ele o responsável pelo prazo).
--  lesson_pendings        aula cujo prazo passou sem presenças: OPEN → SUBMITTED_LATE (o professor
--                         submeteu depois) · FAULT (falta registada: automática ou pelo RH) ·
--                         DISMISSED (o RH dispensou, com motivo). Uma por turma + dia + hora.
--  job_runs               cada execução das tarefas automáticas (monitorização): estado e números.
-- =============================================================================
ALTER TABLE "attendance_settings" ADD COLUMN "tracking_since" DATE NOT NULL DEFAULT CURRENT_DATE;

CREATE TABLE "lesson_substitutions" (
    "id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "substitute_id" UUID NOT NULL,
    "original_teacher_id" UUID,
    "reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lesson_substitutions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lesson_substitutions_lesson_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE,
    CONSTRAINT "lesson_substitutions_substitute_fkey" FOREIGN KEY ("substitute_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "lesson_substitutions_original_fkey" FOREIGN KEY ("original_teacher_id") REFERENCES "employees"("id") ON DELETE SET NULL,
    CONSTRAINT "lesson_substitutions_reason_check" CHECK (char_length(coalesce("reason", '')) <= 200)
);
CREATE UNIQUE INDEX "lesson_substitutions_lesson_day_key" ON "lesson_substitutions"("lesson_id", "day");
CREATE INDEX "lesson_substitutions_substitute_idx" ON "lesson_substitutions"("substitute_id", "day");

CREATE TABLE "lesson_pendings" (
    "id" UUID NOT NULL,
    "lesson_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "teacher_id" UUID,
    "group_name" TEXT NOT NULL,
    "subject_name" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "starts_at" TIME NOT NULL,
    "ends_at" TIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurrence_id" UUID,
    "reason" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lesson_pendings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lesson_pendings_lesson_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL,
    CONSTRAINT "lesson_pendings_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "lesson_pendings_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "lesson_pendings_teacher_fkey" FOREIGN KEY ("teacher_id") REFERENCES "employees"("id") ON DELETE SET NULL,
    CONSTRAINT "lesson_pendings_occurrence_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "teacher_occurrences"("id") ON DELETE SET NULL,
    CONSTRAINT "lesson_pendings_status_check" CHECK ("status" IN ('OPEN', 'SUBMITTED_LATE', 'FAULT', 'DISMISSED')),
    CONSTRAINT "lesson_pendings_reason_check" CHECK (char_length(coalesce("reason", '')) <= 300)
);
CREATE UNIQUE INDEX "lesson_pendings_slot_key" ON "lesson_pendings"("group_id", "day", "starts_at");
CREATE INDEX "lesson_pendings_status_idx" ON "lesson_pendings"("status", "day");
CREATE INDEX "lesson_pendings_teacher_idx" ON "lesson_pendings"("teacher_id", "day");

CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    -- SCHEDULER (ciclo automático) | MANUAL (pedido pela direção)
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stats" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_runs_status_check" CHECK ("status" IN ('RUNNING', 'DONE', 'FAILED', 'SKIPPED'))
);
CREATE INDEX "job_runs_job_idx" ON "job_runs"("job", "started_at" DESC);
