-- Descrição opcional de cada classe (ex.: "Turmas com reforço de Matemática").
-- O curso passa a ser obrigatório no II Ciclo (10.ª–13.ª) — regra aplicada no
-- school-api, para não partir a cópia de estrutura de anos criados antes disto.
ALTER TABLE "school_classes" ADD COLUMN "description" TEXT;
ALTER TABLE "school_classes" ADD CONSTRAINT "school_classes_description_check" CHECK ("description" IS NULL OR char_length("description") <= 160);
