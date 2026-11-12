-- =============================================================================
--  DISCIPLINAS E HORÁRIOS
--
--  subjects          catálogo de disciplinas do colégio (atravessa os anos)
--  class_subjects    plano curricular: disciplinas de cada classe (no ano) e tempos por semana
--  school_periods    tempos letivos de cada turno (hora de início/fim; aula ou intervalo)
--  lessons           horário de cada turma: dia × tempo → disciplina (+ sala, + professor)
--
--  O professor (teacher_id) fica vazio até haver o módulo de professores:
--  o horário impresso mostra "sem professor atribuído".
-- =============================================================================
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    -- cor no horário (#rrggbb)
    "color" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subjects_name_check" CHECK (char_length("name") BETWEEN 2 AND 60),
    CONSTRAINT "subjects_code_check" CHECK ("code" ~ '^[A-Z0-9]{2,6}$'),
    CONSTRAINT "subjects_color_check" CHECK ("color" ~ '^#[0-9a-f]{6}$')
);
CREATE UNIQUE INDEX "subjects_name_key" ON "subjects"(lower("name"));
CREATE UNIQUE INDEX "subjects_code_key" ON "subjects"("code");

CREATE TABLE "class_subjects" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    -- tempos letivos por semana
    "weekly_periods" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "class_subjects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "class_subjects_weekly_check" CHECK ("weekly_periods" BETWEEN 1 AND 20),
    CONSTRAINT "class_subjects_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "class_subjects_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE CASCADE,
    CONSTRAINT "class_subjects_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "class_subjects_class_subject_key" ON "class_subjects"("class_id", "subject_id");
CREATE INDEX "class_subjects_subject_idx" ON "class_subjects"("subject_id");

CREATE TABLE "school_periods" (
    "id" UUID NOT NULL,
    "shift" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "starts_at" TIME NOT NULL,
    "ends_at" TIME NOT NULL,
    -- AULA | INTERVALO
    "kind" TEXT NOT NULL DEFAULT 'AULA',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_periods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_periods_shift_check" CHECK ("shift" IN ('MANHA', 'TARDE', 'NOITE')),
    CONSTRAINT "school_periods_kind_check" CHECK ("kind" IN ('AULA', 'INTERVALO')),
    CONSTRAINT "school_periods_position_check" CHECK ("position" BETWEEN 1 AND 15),
    CONSTRAINT "school_periods_time_check" CHECK ("ends_at" > "starts_at")
);
CREATE UNIQUE INDEX "school_periods_shift_position_key" ON "school_periods"("shift", "position");

CREATE TABLE "lessons" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    -- 1 = segunda … 5 = sexta (6 = sábado, reservado)
    "weekday" INTEGER NOT NULL,
    "period_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    -- professor: preenchido quando existir o módulo de professores
    "teacher_id" UUID,
    "room" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lessons_weekday_check" CHECK ("weekday" BETWEEN 1 AND 6),
    CONSTRAINT "lessons_room_check" CHECK ("room" IS NULL OR char_length("room") <= 40),
    CONSTRAINT "lessons_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "lessons_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "lessons_period_fkey" FOREIGN KEY ("period_id") REFERENCES "school_periods"("id") ON DELETE RESTRICT,
    CONSTRAINT "lessons_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT
);
-- uma turma, um dia, um tempo → uma aula
CREATE UNIQUE INDEX "lessons_slot_key" ON "lessons"("group_id", "weekday", "period_id");
-- a mesma sala não recebe duas turmas ao mesmo tempo (no mesmo ano)
CREATE UNIQUE INDEX "lessons_room_slot_key" ON "lessons"("academic_year_id", "weekday", "period_id", lower("room")) WHERE "room" IS NOT NULL;
CREATE INDEX "lessons_subject_idx" ON "lessons"("subject_id");
CREATE INDEX "lessons_teacher_idx" ON "lessons"("teacher_id") WHERE "teacher_id" IS NOT NULL;
