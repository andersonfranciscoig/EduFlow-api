-- =============================================================================
--  RESULTADO DO ANO — fase F7 do módulo de avaliação: nota final, exame, recuperação, transição.
--
--  grading_progression     as regras de transição do colégio, por ensino (nada é universal):
--                            max_negatives       quantas disciplinas negativas ainda transitam
--                            core_subject_ids    as disciplinas nucleares (ex.: Português, Matemática)
--                            max_core_negatives  quantas destas podem ser negativas
--                          Sem regras para um ensino, o resultado dos alunos fica "por decidir".
--  grading_final_marks     o "Final do ano" de cada aluno numa disciplina: o exame (classes de exame;
--                          com as provas do exame, se o modelo as tiver) e a prova de recuperação.
--  grading_year_decisions  a deliberação da direção (conselho de turma) que muda o resultado
--                          calculado de um aluno: sempre com o motivo, e fica no histórico.
--  grading_terms           passa a aceitar a posição 0 = "Final do ano" (submeter, validar, publicar
--                          e retificar a nota final, como nos períodos).
-- =============================================================================
CREATE TABLE "grading_progression" (
    "level" TEXT NOT NULL,
    "max_negatives" INTEGER,
    "core_subject_ids" UUID[] NOT NULL DEFAULT '{}',
    "max_core_negatives" INTEGER,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_progression_pkey" PRIMARY KEY ("level"),
    CONSTRAINT "grading_progression_level_check" CHECK ("level" IN ('pre', 'primario', 'ciclo1', 'ciclo2')),
    CONSTRAINT "grading_progression_max_check" CHECK ("max_negatives" IS NULL OR "max_negatives" BETWEEN 0 AND 20),
    CONSTRAINT "grading_progression_core_check" CHECK ("max_core_negatives" IS NULL OR "max_core_negatives" BETWEEN 0 AND 20)
);

CREATE TABLE "grading_final_marks" (
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "exam_state" TEXT,
    "exam_value" NUMERIC(7,2),
    "exam_parts" JSONB,
    "recovery_value" NUMERIC(7,2),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_final_marks_pkey" PRIMARY KEY ("group_id", "subject_id", "student_id"),
    CONSTRAINT "grading_final_marks_exam_check" CHECK ("exam_state" IS NULL OR "exam_state" IN ('GRADED', 'ABSENT', 'ABSENT_JUSTIFIED')),
    CONSTRAINT "grading_final_marks_values_check" CHECK (("exam_value" IS NULL OR "exam_value" >= 0) AND ("recovery_value" IS NULL OR "recovery_value" >= 0)),
    CONSTRAINT "grading_final_marks_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_final_marks_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id"),
    CONSTRAINT "grading_final_marks_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id"),
    CONSTRAINT "grading_final_marks_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id")
);

CREATE TABLE "grading_year_decisions" (
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decided_by_id" UUID,
    "decided_by_name" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_year_decisions_pkey" PRIMARY KEY ("academic_year_id", "student_id"),
    CONSTRAINT "grading_year_decisions_outcome_check" CHECK ("outcome" IN ('PASSED', 'RETAINED')),
    CONSTRAINT "grading_year_decisions_reason_check" CHECK (char_length("reason") BETWEEN 3 AND 300),
    CONSTRAINT "grading_year_decisions_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_year_decisions_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id"),
    CONSTRAINT "grading_year_decisions_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id")
);

-- o resultado calculado de cada aluno (regras + notas finais publicadas), guardado para quem precisa dele
-- sem refazer as contas (a renovação propõe a mesma classe a quem não transita). Recalcula-se ao publicar
-- o final do ano de uma turma e quando o colégio muda as regras de transição.
CREATE TABLE "grading_year_results" (
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "computed" TEXT NOT NULL,
    "negatives" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_year_results_pkey" PRIMARY KEY ("academic_year_id", "student_id"),
    CONSTRAINT "grading_year_results_computed_check" CHECK ("computed" IN ('PASSED', 'RETAINED', 'RECOVERY', 'UNDECIDED')),
    CONSTRAINT "grading_year_results_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_year_results_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id"),
    CONSTRAINT "grading_year_results_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id")
);

ALTER TABLE "grading_terms" DROP CONSTRAINT "grading_terms_period_check";
ALTER TABLE "grading_terms" ADD CONSTRAINT "grading_terms_period_check" CHECK ("period_position" BETWEEN 0 AND 3);

ALTER TABLE "grading_changes" DROP CONSTRAINT "grading_changes_kind_check";
ALTER TABLE "grading_changes" ADD CONSTRAINT "grading_changes_kind_check" CHECK ("kind" IN ('ASSESSMENT_CREATED', 'ASSESSMENT_UPDATED', 'ASSESSMENT_DELETED', 'MARK', 'NOTE', 'TERM_SUBMITTED', 'TERM_RETURNED', 'TERM_VALIDATED', 'TERM_PUBLISHED', 'TERM_REOPENED', 'FINAL_MARK', 'YEAR_DECISION'));
