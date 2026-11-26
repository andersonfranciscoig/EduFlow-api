-- =============================================================================
--  CADERNETA DIGITAL — fase F3 do módulo de avaliação.
--
--  grading_assessments   as avaliações que o professor cria numa turma, disciplina e período
--                        (um teste, um trabalho, a participação…), sempre num componente do
--                        modelo (component_key, estável entre versões). out_of = cotação
--                        (null = já na escala do modelo); weight = peso na média ponderada.
--                        O período liga-se por (ano, posição): os períodos do calendário
--                        apagam-se e recriam-se quando mudam as datas.
--  grading_marks         a nota de cada aluno numa avaliação. Sem linha = ainda por lançar.
--                        state: GRADED (com nota) · ABSENT (falta injustificada)
--                               ABSENT_JUSTIFIED (falta justificada) · EXEMPT (dispensado)
--  grading_period_notes  por aluno, disciplina e período: a menção (modelos qualitativos) e a
--                        apreciação escrita do professor.
--  grading_changes       o histórico, só de acrescentar: quem criou, mudou ou apagou cada
--                        avaliação e cada nota, com o antes e o depois. Não tem chaves
--                        estrangeiras de propósito: sobrevive a uma avaliação apagada.
--
--  As chaves para turmas, disciplinas e alunos são NO ACTION: não se apaga uma turma ou uma
--  disciplina com notas (a API avisa antes), mas apagar um ano letivo em preparação leva tudo.
-- =============================================================================
CREATE TABLE "grading_assessments" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "period_position" INTEGER NOT NULL,
    "component_key" TEXT NOT NULL,
    "type_id" UUID,
    "name" TEXT NOT NULL,
    "held_on" DATE,
    "out_of" NUMERIC(7,2),
    "weight" NUMERIC(5,2),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_assessments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_assessments_period_check" CHECK ("period_position" BETWEEN 1 AND 3),
    CONSTRAINT "grading_assessments_name_check" CHECK (char_length("name") BETWEEN 2 AND 80),
    CONSTRAINT "grading_assessments_out_of_check" CHECK ("out_of" IS NULL OR ("out_of" > 0 AND "out_of" <= 1000)),
    CONSTRAINT "grading_assessments_weight_check" CHECK ("weight" IS NULL OR ("weight" > 0 AND "weight" <= 100)),
    CONSTRAINT "grading_assessments_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_assessments_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id"),
    CONSTRAINT "grading_assessments_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id"),
    CONSTRAINT "grading_assessments_type_fkey" FOREIGN KEY ("type_id") REFERENCES "grading_types"("id") ON DELETE SET NULL
);
CREATE INDEX "grading_assessments_book_idx" ON "grading_assessments"("group_id", "subject_id", "period_position");
CREATE INDEX "grading_assessments_year_idx" ON "grading_assessments"("academic_year_id");

CREATE TABLE "grading_marks" (
    "assessment_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "score" NUMERIC(7,2),
    "note" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_marks_pkey" PRIMARY KEY ("assessment_id", "student_id"),
    CONSTRAINT "grading_marks_state_check" CHECK ("state" IN ('GRADED', 'ABSENT', 'ABSENT_JUSTIFIED', 'EXEMPT')),
    -- com nota ⇔ há valor
    CONSTRAINT "grading_marks_score_check" CHECK (("state" = 'GRADED') = ("score" IS NOT NULL) AND ("score" IS NULL OR "score" >= 0)),
    CONSTRAINT "grading_marks_note_check" CHECK ("note" IS NULL OR char_length("note") <= 200),
    CONSTRAINT "grading_marks_assessment_fkey" FOREIGN KEY ("assessment_id") REFERENCES "grading_assessments"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_marks_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id")
);
CREATE INDEX "grading_marks_student_idx" ON "grading_marks"("student_id");

CREATE TABLE "grading_period_notes" (
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "period_position" INTEGER NOT NULL,
    "student_id" UUID NOT NULL,
    "level_key" TEXT,
    "comment" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_period_notes_pkey" PRIMARY KEY ("group_id", "subject_id", "period_position", "student_id"),
    CONSTRAINT "grading_period_notes_period_check" CHECK ("period_position" BETWEEN 1 AND 3),
    CONSTRAINT "grading_period_notes_comment_check" CHECK ("comment" IS NULL OR char_length("comment") <= 1000),
    CONSTRAINT "grading_period_notes_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_period_notes_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id"),
    CONSTRAINT "grading_period_notes_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id"),
    CONSTRAINT "grading_period_notes_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id")
);

CREATE TABLE "grading_changes" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "period_position" INTEGER NOT NULL,
    "assessment_id" UUID,
    "student_id" UUID,
    -- ASSESSMENT_CREATED · ASSESSMENT_UPDATED · ASSESSMENT_DELETED · MARK · NOTE
    "kind" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "by_id" UUID,
    "by_name" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_changes_kind_check" CHECK ("kind" IN ('ASSESSMENT_CREATED', 'ASSESSMENT_UPDATED', 'ASSESSMENT_DELETED', 'MARK', 'NOTE'))
);
CREATE INDEX "grading_changes_book_idx" ON "grading_changes"("group_id", "subject_id", "period_position", "at" DESC);
CREATE INDEX "grading_changes_student_idx" ON "grading_changes"("student_id", "at" DESC);

-- só de acrescentar: o histórico das notas não se altera nem se apaga
CREATE FUNCTION grading_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'grading_changes é só de acrescentar';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER grading_changes_no_update BEFORE UPDATE OR DELETE ON "grading_changes" FOR EACH ROW EXECUTE FUNCTION grading_changes_append_only();
