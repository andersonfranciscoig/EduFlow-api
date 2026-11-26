-- =============================================================================
--  CADERNETA ↔ CALENDÁRIO DE PROVAS — fase F4 do módulo de avaliação.
--
--  grading_assessments.exam_id   a prova do calendário (publicado) que esta avaliação regista.
--                                A data da avaliação é a da prova; só se lançam notas a partir
--                                desse dia. Uma prova regista-se numa só avaliação.
--                                Se a prova for retirada do calendário (só possível enquanto a
--                                época se prepara), a avaliação e as notas ficam (SET NULL).
-- =============================================================================
ALTER TABLE "grading_assessments" ADD COLUMN "exam_id" UUID;
ALTER TABLE "grading_assessments" ADD CONSTRAINT "grading_assessments_exam_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "grading_assessments_exam_key" ON "grading_assessments"("exam_id") WHERE "exam_id" IS NOT NULL;
