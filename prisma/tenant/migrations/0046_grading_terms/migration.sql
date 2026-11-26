-- =============================================================================
--  FECHO DOS PERÍODOS — fase F5 do módulo de avaliação: submeter, validar, publicar, retificar.
--
--  grading_terms         o estado das classificações de uma disciplina numa turma, num período.
--                        Sem linha = "Em preparação" (o professor lança à vontade).
--                          RETURNED   devolvida ao professor (com o motivo): volta a poder alterar
--                          SUBMITTED  submetida pelo professor: pendente de validação (não se altera)
--                          VALIDATED  validada pelo diretor de turma ou pela pedagogia
--                          PUBLISHED  publicada pela direção: as famílias veem (publications ≥ 1;
--                                     a partir da 2.ª publicação diz-se "retificada")
--                          REOPENED   reaberta para retificação (com o motivo): o professor corrige
--                        results      as classificações congeladas na submissão (o que se valida e
--                                     publica é exatamente o que o professor submeteu)
--                        model_*      o modelo e a versão com que foram calculadas; depois de
--                                     publicadas, a caderneta fica com essa versão (uma versão nova
--                                     do modelo não mexe num período já publicado)
--  grading_publications  cada publicação, tal como foi: só de acrescentar (é o que as famílias veem
--                        e o que fica para a auditoria).
--  O histórico (quem submeteu, devolveu, validou, publicou, reabriu, e porquê) fica em grading_changes.
-- =============================================================================
CREATE TABLE "grading_terms" (
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "period_position" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "model_id" UUID,
    "model_version" INTEGER,
    "results" JSONB,
    "publications" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "submitted_at" TIMESTAMP(3),
    "submitted_by_id" UUID,
    "validated_at" TIMESTAMP(3),
    "validated_by_id" UUID,
    "published_at" TIMESTAMP(3),
    "published_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_terms_pkey" PRIMARY KEY ("group_id", "subject_id", "period_position"),
    CONSTRAINT "grading_terms_period_check" CHECK ("period_position" BETWEEN 1 AND 3),
    CONSTRAINT "grading_terms_status_check" CHECK ("status" IN ('RETURNED', 'SUBMITTED', 'VALIDATED', 'PUBLISHED', 'REOPENED')),
    CONSTRAINT "grading_terms_results_check" CHECK ("status" IN ('RETURNED', 'REOPENED') OR "results" IS NOT NULL),
    CONSTRAINT "grading_terms_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_terms_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id"),
    CONSTRAINT "grading_terms_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id"),
    CONSTRAINT "grading_terms_model_fkey" FOREIGN KEY ("model_id") REFERENCES "grading_models"("id") ON DELETE RESTRICT
);
CREATE INDEX "grading_terms_year_idx" ON "grading_terms"("academic_year_id", "period_position", "status");

CREATE TABLE "grading_publications" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "period_position" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "model_id" UUID,
    "model_version" INTEGER,
    "results" JSONB NOT NULL,
    "reason" TEXT,
    "published_by_id" UUID,
    "published_by_name" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_publications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_publications_number_check" CHECK ("number" >= 1)
);
CREATE UNIQUE INDEX "grading_publications_number_key" ON "grading_publications"("group_id", "subject_id", "period_position", "number");

CREATE FUNCTION grading_publications_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'grading_publications é só de acrescentar';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER grading_publications_no_update BEFORE UPDATE OR DELETE ON "grading_publications" FOR EACH ROW EXECUTE FUNCTION grading_publications_append_only();

-- o histórico da caderneta passa a registar também o fecho dos períodos
ALTER TABLE "grading_changes" DROP CONSTRAINT "grading_changes_kind_check";
ALTER TABLE "grading_changes" ADD CONSTRAINT "grading_changes_kind_check" CHECK ("kind" IN ('ASSESSMENT_CREATED', 'ASSESSMENT_UPDATED', 'ASSESSMENT_DELETED', 'MARK', 'NOTE', 'TERM_SUBMITTED', 'TERM_RETURNED', 'TERM_VALIDATED', 'TERM_PUBLISHED', 'TERM_REOPENED'));
