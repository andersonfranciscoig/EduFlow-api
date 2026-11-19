-- =============================================================================
--  Disciplinas: descrição (o que se estuda), mostrada às famílias no horário.
-- =============================================================================
ALTER TABLE "subjects" ADD COLUMN "description" TEXT;
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_description_check" CHECK ("description" IS NULL OR char_length("description") <= 400);
