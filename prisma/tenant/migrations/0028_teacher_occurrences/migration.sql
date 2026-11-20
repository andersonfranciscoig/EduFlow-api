-- =============================================================================
--  OCORRÊNCIAS DE ASSIDUIDADE DOS PROFESSORES (área do RH).
--
--  teacher_occurrences   uma falta ou atraso de um professor:
--      scope     LESSON (uma aula do horário — modelo "por aula") | DAY (o dia — modelo "por dia")
--      kind      FALTA | ATRASO (com os minutos)
--      source    MANUAL (marcada pelo RH) | AUTOMATIC (o sistema, quando o professor não
--                submete as presenças no prazo e o colégio escolheu a gestão automática)
--      status    REGISTADA → JUSTIFICADA (com a justificação) · ANULADA (com o motivo)
--                e pode voltar a REGISTADA (reabrir). Tudo fica na atividade (antes → depois, motivo).
--  Da aula guarda-se uma cópia (turma, disciplina, horas): o horário pode mudar depois.
--  Uma ocorrência ativa (não anulada) por professor + aula + dia, ou por professor + dia.
-- =============================================================================
CREATE TABLE "teacher_occurrences" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "scope" TEXT NOT NULL,
    "lesson_id" UUID,
    "group_name" TEXT,
    "subject_name" TEXT,
    "starts_at" TIME,
    "ends_at" TIME,
    "kind" TEXT NOT NULL,
    "minutes_late" INTEGER,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTADA',
    "note" TEXT,
    "justification" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "teacher_occurrences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "teacher_occurrences_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "teacher_occurrences_lesson_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL,
    CONSTRAINT "teacher_occurrences_scope_check" CHECK ("scope" IN ('LESSON', 'DAY')),
    CONSTRAINT "teacher_occurrences_kind_check" CHECK ("kind" IN ('FALTA', 'ATRASO')),
    CONSTRAINT "teacher_occurrences_source_check" CHECK ("source" IN ('MANUAL', 'AUTOMATIC')),
    CONSTRAINT "teacher_occurrences_status_check" CHECK ("status" IN ('REGISTADA', 'JUSTIFICADA', 'ANULADA')),
    CONSTRAINT "teacher_occurrences_late_check" CHECK ((("kind" = 'ATRASO') = ("minutes_late" IS NOT NULL)) AND ("minutes_late" IS NULL OR "minutes_late" BETWEEN 1 AND 600)),
    CONSTRAINT "teacher_occurrences_lesson_check" CHECK ("scope" = 'LESSON' OR ("lesson_id" IS NULL AND "starts_at" IS NULL)),
    CONSTRAINT "teacher_occurrences_text_check" CHECK (char_length(coalesce("note", '')) <= 300 AND char_length(coalesce("justification", '')) <= 500),
    CONSTRAINT "teacher_occurrences_justified_check" CHECK ("status" <> 'JUSTIFICADA' OR char_length(coalesce("justification", '')) >= 3)
);
-- uma ocorrência ativa por aula (pela hora de início: a aula pode ter sido apagada) e uma por dia
CREATE UNIQUE INDEX "teacher_occurrences_lesson_key" ON "teacher_occurrences"("employee_id", "day", "starts_at") WHERE "scope" = 'LESSON' AND "status" <> 'ANULADA';
CREATE UNIQUE INDEX "teacher_occurrences_day_key" ON "teacher_occurrences"("employee_id", "day") WHERE "scope" = 'DAY' AND "status" <> 'ANULADA';
CREATE INDEX "teacher_occurrences_day_idx" ON "teacher_occurrences"("day");
CREATE INDEX "teacher_occurrences_status_idx" ON "teacher_occurrences"("status", "day");
