-- =============================================================================
--  CURSOS — catálogo do colégio (atravessa os anos letivos)
--
--  Ensino geral (GERAL): 10.ª a 12.ª   ·   Técnico-profissional (TECNICO): 10.ª a 13.ª
--  As classes do II Ciclo passam a apontar para um curso (course_id) em vez de
--  guardarem o nome solto: mudar o nome do curso muda-o em todas as classes.
-- =============================================================================
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- sigla (ex.: CFB), opcional
    "code" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'GERAL',
    "description" TEXT,
    -- arquivado: não aparece para novas classes; as existentes mantêm-no
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "courses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "courses_kind_check" CHECK ("kind" IN ('GERAL', 'TECNICO')),
    CONSTRAINT "courses_name_check" CHECK (char_length("name") BETWEEN 2 AND 80),
    CONSTRAINT "courses_code_check" CHECK ("code" IS NULL OR "code" ~ '^[A-Z0-9]{2,8}$'),
    CONSTRAINT "courses_description_check" CHECK ("description" IS NULL OR char_length("description") <= 300)
);
CREATE UNIQUE INDEX "courses_name_key" ON "courses"(lower("name"));
CREATE UNIQUE INDEX "courses_code_key" ON "courses"("code") WHERE "code" IS NOT NULL;

-- os cursos já escritos nas classes passam para o catálogo (um por nome, sem diferenciar maiúsculas);
-- quem já tem 13.ª é técnico-profissional
INSERT INTO "courses" ("id", "name", "kind", "created_at", "updated_at")
SELECT gen_random_uuid(), min("course"), CASE WHEN bool_or("grade" = 13) THEN 'TECNICO' ELSE 'GERAL' END, now(), now()
FROM "school_classes"
WHERE "course" IS NOT NULL
GROUP BY lower("course");

ALTER TABLE "school_classes" ADD COLUMN "course_id" UUID;
UPDATE "school_classes" c SET "course_id" = k."id" FROM "courses" k WHERE lower(c."course") = lower(k."name");
ALTER TABLE "school_classes" ADD CONSTRAINT "school_classes_course_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT;

-- a unicidade passa a ser por curso (id), não pelo texto
DROP INDEX "school_classes_year_grade_course_key";
ALTER TABLE "school_classes" DROP COLUMN "course";
CREATE UNIQUE INDEX "school_classes_year_grade_course_key" ON "school_classes"("academic_year_id", "grade", COALESCE("course_id", '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX "school_classes_course_idx" ON "school_classes"("course_id");
