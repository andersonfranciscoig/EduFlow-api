-- =============================================================================
--  CALENDÁRIO DE PROVAS — vigilantes e avisos a cada professor.
--
--  exam_invigilators   os professores escalados para vigiar cada prova (um ou vários).
--  exam_notices.kind   GENERAL       o mesmo texto para todos
--                      PUBLISHED     publicação: cada professor recebe as datas das suas provas, e cada
--                                    vigilante as provas que vai vigiar
--                      INVIGILATION  só os professores indicados (escalado / retirado da vigilância)
-- =============================================================================
CREATE TABLE "exam_invigilators" (
    "exam_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exam_invigilators_pkey" PRIMARY KEY ("exam_id", "employee_id"),
    CONSTRAINT "exam_invigilators_exam_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE,
    CONSTRAINT "exam_invigilators_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE
);
CREATE INDEX "exam_invigilators_employee_idx" ON "exam_invigilators"("employee_id");

ALTER TABLE "exam_notices" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "exam_notices" ADD CONSTRAINT "exam_notices_kind_check" CHECK ("kind" IN ('GENERAL', 'PUBLISHED', 'INVIGILATION'));
