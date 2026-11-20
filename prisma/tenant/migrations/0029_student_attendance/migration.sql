-- =============================================================================
--  PRESENÇAS DOS ALUNOS — fase P1.
--
--  lesson_sessions      a aula dada num dia (do horário semanal `lessons`): turma, disciplina,
--                       professor e horas (cópia: o horário pode mudar depois). Criada quando o
--                       professor submete as presenças. Uma por turma + dia + hora de início.
--                       late = submetida depois do prazo (regras de assiduidade).
--  student_attendance   a presença de cada aluno nessa aula:
--                       PRESENTE · AUSENTE · ATRASADO (minutos, opcional) · FALTA_JUSTIFICADA.
--                       Uma por aula + aluno. Correções depois do prazo: só com permissão e motivo
--                       (ficam na atividade: antes → depois).
-- =============================================================================
CREATE TABLE "lesson_sessions" (
    "id" UUID NOT NULL,
    "lesson_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "teacher_id" UUID,
    "day" DATE NOT NULL,
    "starts_at" TIME NOT NULL,
    "ends_at" TIME NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "submitted_by_id" UUID,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lesson_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lesson_sessions_lesson_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL,
    CONSTRAINT "lesson_sessions_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "lesson_sessions_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "lesson_sessions_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT,
    CONSTRAINT "lesson_sessions_teacher_fkey" FOREIGN KEY ("teacher_id") REFERENCES "employees"("id") ON DELETE SET NULL,
    CONSTRAINT "lesson_sessions_time_check" CHECK ("ends_at" > "starts_at")
);
CREATE UNIQUE INDEX "lesson_sessions_slot_key" ON "lesson_sessions"("group_id", "day", "starts_at");
CREATE INDEX "lesson_sessions_teacher_day_idx" ON "lesson_sessions"("teacher_id", "day");
CREATE INDEX "lesson_sessions_day_idx" ON "lesson_sessions"("day");

CREATE TABLE "student_attendance" (
    "session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "minutes_late" INTEGER,
    "note" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_attendance_pkey" PRIMARY KEY ("session_id", "student_id"),
    CONSTRAINT "student_attendance_session_fkey" FOREIGN KEY ("session_id") REFERENCES "lesson_sessions"("id") ON DELETE CASCADE,
    CONSTRAINT "student_attendance_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE,
    CONSTRAINT "student_attendance_status_check" CHECK ("status" IN ('PRESENTE', 'AUSENTE', 'ATRASADO', 'FALTA_JUSTIFICADA')),
    CONSTRAINT "student_attendance_late_check" CHECK ("minutes_late" IS NULL OR ("status" = 'ATRASADO' AND "minutes_late" BETWEEN 1 AND 300)),
    CONSTRAINT "student_attendance_note_check" CHECK (char_length(coalesce("note", '')) <= 200)
);
CREATE INDEX "student_attendance_student_idx" ON "student_attendance"("student_id", "status");
