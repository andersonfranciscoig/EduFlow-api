-- =============================================================================
--  PROFESSORES
--
--  employees.user_id      conta do portal ligada ao funcionário (o RH dá acesso):
--                         o professor entra e vê "O meu horário". Uma conta por funcionário.
--  group_teachers         quem dá cada disciplina em cada turma (um professor por disciplina/turma).
--  class_groups.coordinator_id   coordenador (diretor) de turma.
--  lessons.teacher_id     o professor da aula = o da disciplina nessa turma (mantido pela API);
--                         serve para os choques (o mesmo professor em duas turmas à mesma hora)
--                         e para o horário de cada professor.
-- =============================================================================
ALTER TABLE "employees" ADD COLUMN "user_id" UUID;
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_fkey" FOREIGN KEY ("user_id") REFERENCES "school_users"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "employees_user_key" ON "employees"("user_id");

ALTER TABLE "class_groups" ADD COLUMN "coordinator_id" UUID;
ALTER TABLE "class_groups" ADD CONSTRAINT "class_groups_coordinator_fkey" FOREIGN KEY ("coordinator_id") REFERENCES "employees"("id") ON DELETE SET NULL;
CREATE INDEX "class_groups_coordinator_idx" ON "class_groups"("coordinator_id");

CREATE TABLE "group_teachers" (
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "assigned_by_id" UUID,
    "assigned_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "group_teachers_pkey" PRIMARY KEY ("group_id", "subject_id"),
    CONSTRAINT "group_teachers_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "group_teachers_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE,
    CONSTRAINT "group_teachers_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE
);
CREATE INDEX "group_teachers_employee_idx" ON "group_teachers"("employee_id");

-- até agora sempre vazio: pode ganhar a chave estrangeira
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_teacher_fkey" FOREIGN KEY ("teacher_id") REFERENCES "employees"("id") ON DELETE SET NULL;
-- o índice antigo (só professor) dá lugar a professor + dia (choques e horário do professor)
DROP INDEX IF EXISTS "lessons_teacher_idx";
CREATE INDEX "lessons_teacher_day_idx" ON "lessons"("teacher_id", "weekday") WHERE "teacher_id" IS NOT NULL;
