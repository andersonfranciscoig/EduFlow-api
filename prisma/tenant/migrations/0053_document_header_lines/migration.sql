-- DOCUMENTOS: o cabeçalho oficial passa a ter as linhas que o colégio quiser (1 a 6), por ordem,
-- por cima do nome do colégio (ex.: "República de Angola", "Ministério da Educação", "Governo
-- Provincial de Luanda", "Gabinete Provincial da Educação"). As duas linhas fixas passam para a lista.

ALTER TABLE "document_header_settings" ADD COLUMN "lines" JSONB NOT NULL DEFAULT '["República de Angola", "Ministério da Educação"]';

UPDATE "document_header_settings"
   SET "lines" = CASE WHEN coalesce(btrim("ministry_line"), '') = '' THEN jsonb_build_array("country_line")
                      ELSE jsonb_build_array("country_line", "ministry_line") END;

ALTER TABLE "document_header_settings" DROP COLUMN "country_line", DROP COLUMN "ministry_line";
ALTER TABLE "document_header_settings" ADD CONSTRAINT "document_header_settings_lines_check"
  CHECK (jsonb_typeof("lines") = 'array' AND jsonb_array_length("lines") BETWEEN 1 AND 6);
