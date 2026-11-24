-- =============================================================================
--  CALENDÁRIO DE PROVAS — fase P7.
--
--  exam_seasons           as provas de cada período de avaliação (o modelo do colégio): tantas
--                         linhas quantas as provas do período, cada uma com o seu nome. Depois
--                         configura-se cada uma: datas, com ou sem interrupção das aulas, modalidade
--                         habitual, turmas e disciplinas abrangidas.
--                           status      DRAFT (a preparar) | PUBLISHED (visível a professores e famílias)
--                           interrupts  A. com interrupção: depois de publicada, nas datas da prova
--                                       não há aulas normais nas turmas abrangidas;
--                                       B. sem interrupção: as aulas mantêm-se.
--  exam_season_groups     turmas abrangidas
--  exam_season_subjects   disciplinas abrangidas, por classe
--  exams                  cada prova marcada: turma, disciplina, professor responsável, dia, hora,
--                         sala, modalidade, observações. SCHEDULED | CANCELLED (com o motivo).
--                         Uma prova por turma + disciplina + modalidade em cada época.
--  exam_notices           avisos a entregar (publicação, alterações, cancelamentos): gravados na
--                         mesma transação da alteração e entregues a seguir; o que falhar é
--                         retomado pelo ciclo automático, sem repetir.
--  O histórico de alterações fica em school_activity (assunto = a época).
-- =============================================================================
CREATE TABLE "exam_seasons" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "period_position" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "starts_on" DATE,
    "ends_on" DATE,
    "interrupts" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT NOT NULL DEFAULT 'ESCRITA',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "published_at" TIMESTAMP(3),
    "published_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exam_seasons_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exam_seasons_period_check" CHECK ("period_position" BETWEEN 1 AND 3),
    CONSTRAINT "exam_seasons_name_check" CHECK (char_length("name") BETWEEN 2 AND 60),
    CONSTRAINT "exam_seasons_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED')),
    CONSTRAINT "exam_seasons_format_check" CHECK ("format" IN ('ESCRITA', 'ORAL', 'PRATICA', 'OUTRA')),
    CONSTRAINT "exam_seasons_dates_check" CHECK (("starts_on" IS NULL) = ("ends_on" IS NULL) AND "ends_on" >= "starts_on"),
    CONSTRAINT "exam_seasons_published_check" CHECK ("status" <> 'PUBLISHED' OR "starts_on" IS NOT NULL),
    CONSTRAINT "exam_seasons_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE
);
CREATE INDEX "exam_seasons_year_idx" ON "exam_seasons"("academic_year_id", "period_position", "position");

CREATE TABLE "exam_season_groups" (
    "season_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    CONSTRAINT "exam_season_groups_pkey" PRIMARY KEY ("season_id", "group_id"),
    CONSTRAINT "exam_season_groups_season_fkey" FOREIGN KEY ("season_id") REFERENCES "exam_seasons"("id") ON DELETE CASCADE,
    CONSTRAINT "exam_season_groups_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE
);
CREATE INDEX "exam_season_groups_group_idx" ON "exam_season_groups"("group_id");

CREATE TABLE "exam_season_subjects" (
    "season_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    CONSTRAINT "exam_season_subjects_pkey" PRIMARY KEY ("season_id", "class_id", "subject_id"),
    CONSTRAINT "exam_season_subjects_season_fkey" FOREIGN KEY ("season_id") REFERENCES "exam_seasons"("id") ON DELETE CASCADE,
    CONSTRAINT "exam_season_subjects_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE CASCADE,
    CONSTRAINT "exam_season_subjects_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE
);

CREATE TABLE "exams" (
    "id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "teacher_id" UUID,
    "day" DATE NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "room" TEXT,
    "format" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exams_times_check" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "exams_format_check" CHECK ("format" IN ('ESCRITA', 'ORAL', 'PRATICA', 'OUTRA')),
    CONSTRAINT "exams_status_check" CHECK ("status" IN ('SCHEDULED', 'CANCELLED')),
    CONSTRAINT "exams_cancel_check" CHECK ("status" <> 'CANCELLED' OR "cancel_reason" IS NOT NULL),
    CONSTRAINT "exams_season_fkey" FOREIGN KEY ("season_id") REFERENCES "exam_seasons"("id") ON DELETE CASCADE,
    CONSTRAINT "exams_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "exams_subject_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT,
    CONSTRAINT "exams_teacher_fkey" FOREIGN KEY ("teacher_id") REFERENCES "employees"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "exams_season_group_subject_format_key" ON "exams"("season_id", "group_id", "subject_id", "format") WHERE "status" = 'SCHEDULED';
CREATE INDEX "exams_group_day_idx" ON "exams"("group_id", "day");
CREATE INDEX "exams_teacher_day_idx" ON "exams"("teacher_id", "day");

CREATE TABLE "exam_notices" (
    "id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    -- turmas a avisar (famílias, coordenadores)
    "group_ids" UUID[] NOT NULL,
    -- disciplina (só os professores dela nessas turmas); null = os de todas as abrangidas
    "subject_id" UUID,
    -- outros professores a avisar (ex.: o responsável anterior)
    "teacher_ids" UUID[] NOT NULL DEFAULT '{}',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "family_sent_at" TIMESTAMP(3),
    "staff_sent_at" TIMESTAMP(3),
    "error" TEXT,
    CONSTRAINT "exam_notices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exam_notices_season_fkey" FOREIGN KEY ("season_id") REFERENCES "exam_seasons"("id") ON DELETE CASCADE
);
CREATE INDEX "exam_notices_pending_idx" ON "exam_notices"("created_at") WHERE "family_sent_at" IS NULL OR "staff_sent_at" IS NULL;
