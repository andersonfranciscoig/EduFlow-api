-- =============================================================================
--  CALENDÁRIO DE PROVAS — geração automática (fase P8).
--
--  exams.source   MANUAL     marcada (ou ajustada) à mão: "gerar de novo" não lhe mexe
--                 AUTOMATIC  veio da proposta automática e ainda não foi ajustada
-- =============================================================================
ALTER TABLE "exams" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "exams" ADD CONSTRAINT "exams_source_check" CHECK ("source" IN ('MANUAL', 'AUTOMATIC'));
