-- =============================================================================
--  SUMÁRIOS DAS AULAS.
--  O sumário fica na aula dada (lesson_sessions): escreve-se ao registar as presenças e o
--  professor pode corrigi-lo depois (fica na atividade: antes → depois). O n.º da lição conta-se
--  por turma + disciplina + ano letivo, pela ordem das aulas (calculado ao ler).
-- =============================================================================
ALTER TABLE "lesson_sessions" ADD COLUMN "summary" TEXT;
ALTER TABLE "lesson_sessions" ADD COLUMN "summary_by_id" UUID;
ALTER TABLE "lesson_sessions" ADD COLUMN "summary_updated_at" TIMESTAMP(3);
ALTER TABLE "lesson_sessions" ADD CONSTRAINT "lesson_sessions_summary_check" CHECK (char_length(coalesce("summary", '')) <= 2000);
CREATE INDEX "lesson_sessions_book_idx" ON "lesson_sessions"("group_id", "subject_id", "day", "starts_at");
