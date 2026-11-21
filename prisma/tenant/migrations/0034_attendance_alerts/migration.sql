-- =============================================================================
--  ALERTAS DE ASSIDUIDADE DOS ALUNOS — fase P5.
--
--  attendance_alerts   quando um aluno chega a um limite das regras do colégio numa turma
--                      (ABSENCES: n.º de faltas não justificadas; STREAK: faltas seguidas),
--                      avisa-se o diretor de turma e a família (o encarregado se o aluno é
--                      menor; o próprio aluno se é maior e tem conta). A chave (dedupe_key)
--                      garante um só alerta por limite atingido:
--                        ABSENCES  absences:<turma>:<limite>
--                        STREAK    streak:<turma>:<dia da 1.ª falta da sequência>:<limite>
-- =============================================================================
CREATE TABLE "attendance_alerts" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "rule" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "session_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_alerts_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE,
    CONSTRAINT "attendance_alerts_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "attendance_alerts_rule_check" CHECK ("rule" IN ('ABSENCES', 'STREAK'))
);
CREATE UNIQUE INDEX "attendance_alerts_key" ON "attendance_alerts"("student_id", "dedupe_key");
CREATE INDEX "attendance_alerts_group_idx" ON "attendance_alerts"("group_id", "created_at");
