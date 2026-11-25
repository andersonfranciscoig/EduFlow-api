-- =============================================================================
--  CRITÉRIOS DE AVALIAÇÃO — fase F1 do módulo de avaliação.
--
--  grading_models          os modelos do colégio (nome, rascunho em edição e versão em vigor).
--                            draft            o que se está a editar (pode estar incompleto)
--                            current_version  a última versão publicada (null = nunca publicado)
--                            revision         sobe a cada gravação: duas janelas não se pisam
--  grading_model_versions  cada versão publicada, imutável: escala, componentes e pesos,
--                          arredondamentos, faltas, médias do ano, exame e recuperação.
--                          Os períodos fechados ficam com a versão com que foram calculados.
--  grading_rules           que modelo se aplica a quê, em cada ano letivo. Ganha a mais específica:
--                          disciplina › classe › curso › ensino › todo o colégio
--                          (e, no mesmo sítio, a de um período ganha à do ano todo).
--  grading_types           os elementos de avaliação do colégio (participação, testes, trabalhos…).
--  O histórico de alterações fica em school_activity (assunto = o modelo, ou o ano letivo nas regras).
-- =============================================================================
CREATE TABLE "grading_models" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "draft" JSONB,
    "current_version" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_models_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_models_name_check" CHECK (char_length("name") BETWEEN 3 AND 80),
    -- nunca fica sem conteúdo: ou há rascunho, ou há uma versão publicada
    CONSTRAINT "grading_models_content_check" CHECK ("draft" IS NOT NULL OR "current_version" IS NOT NULL)
);
CREATE UNIQUE INDEX "grading_models_name_key" ON "grading_models"(lower("name"));

CREATE TABLE "grading_model_versions" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "reason" TEXT,
    "published_by_id" UUID,
    "published_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_model_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_model_versions_number_check" CHECK ("number" >= 1),
    CONSTRAINT "grading_model_versions_model_fkey" FOREIGN KEY ("model_id") REFERENCES "grading_models"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "grading_model_versions_number_key" ON "grading_model_versions"("model_id", "number");

CREATE TABLE "grading_rules" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    -- no máximo um destes três (nenhum = todo o colégio)
    "level" TEXT,
    "course_id" UUID,
    "class_id" UUID,
    -- opcionais, em qualquer dos anteriores
    "subject_id" UUID,
    "period_position" INTEGER,
    "model_id" UUID NOT NULL,
    "set_by_id" UUID,
    "set_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_rules_level_check" CHECK ("level" IS NULL OR "level" IN ('pre', 'primario', 'ciclo1', 'ciclo2')),
    CONSTRAINT "grading_rules_scope_check" CHECK (num_nonnulls("level", "course_id", "class_id") <= 1),
    CONSTRAINT "grading_rules_period_check" CHECK ("period_position" BETWEEN 1 AND 3),
    CONSTRAINT "grading_rules_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_rules_course_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_rules_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_rules_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE,
    CONSTRAINT "grading_rules_model_fkey" FOREIGN KEY ("model_id") REFERENCES "grading_models"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "grading_rules_scope_key" ON "grading_rules"("academic_year_id", coalesce("level", ''), coalesce("course_id"::text, ''), coalesce("class_id"::text, ''), coalesce("subject_id"::text, ''), coalesce("period_position", 0));
CREATE INDEX "grading_rules_model_idx" ON "grading_rules"("model_id");

CREATE TABLE "grading_types" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "grading_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_types_name_check" CHECK (char_length("name") BETWEEN 2 AND 60)
);
CREATE UNIQUE INDEX "grading_types_name_key" ON "grading_types"(lower("name"));
