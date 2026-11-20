-- =============================================================================
--  CALENDÁRIO ESCOLAR + CONFIGURAÇÃO DA ASSIDUIDADE — fase P0.
--
--  academic_years.period_kind   como se divide o ano: TRIMESTRE (3 períodos) | SEMESTRE (2).
--  academic_periods             os períodos de avaliação do ano (1.º, 2.º, 3.º…), com datas.
--                               Dentro das datas do ano, por ordem e sem se sobreporem
--                               (a aplicação garante a ordem; aqui, cada um dentro do ano).
--  school_closures              dias sem aulas (feriados, pausas, outros): nestes dias não há
--                               aulas a registar nem pendências.
--  attendance_settings          configuração do colégio (uma linha):
--      teacher_model            PER_LESSON (cada aula) | PER_DAY (um registo por dia: presente
--                               se submeteu as presenças de pelo menos uma aula prevista)
--      missing_procedure        MANUAL (o RH decide) | AUTOMATIC (regista a ocorrência, o RH corrige)
--      deadline_minutes         prazo para submeter as presenças depois do fim da aula
--      absence_limit            faltas (no período) a partir das quais há alerta de assiduidade crítica
--      consecutive_limit        faltas seguidas que geram alerta
--      time_zone                fuso horário do colégio (os prazos e os resumos usam-no)
-- =============================================================================
ALTER TABLE "academic_years" ADD COLUMN "period_kind" TEXT NOT NULL DEFAULT 'TRIMESTRE';
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_period_kind_check" CHECK ("period_kind" IN ('TRIMESTRE', 'SEMESTRE'));

CREATE TABLE "academic_periods" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "academic_periods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "academic_periods_position_check" CHECK ("position" BETWEEN 1 AND 3),
    CONSTRAINT "academic_periods_dates_check" CHECK ("ends_on" >= "starts_on"),
    CONSTRAINT "academic_periods_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "academic_periods_year_position_key" ON "academic_periods"("academic_year_id", "position");

CREATE TABLE "school_closures" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    -- FERIADO | PAUSA | OUTRO
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_closures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_closures_kind_check" CHECK ("kind" IN ('FERIADO', 'PAUSA', 'OUTRO')),
    CONSTRAINT "school_closures_dates_check" CHECK ("ends_on" >= "starts_on"),
    CONSTRAINT "school_closures_reason_check" CHECK (char_length("reason") BETWEEN 2 AND 120),
    CONSTRAINT "school_closures_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE
);
CREATE INDEX "school_closures_year_dates_idx" ON "school_closures"("academic_year_id", "starts_on");

CREATE TABLE "attendance_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "teacher_model" TEXT NOT NULL DEFAULT 'PER_LESSON',
    "missing_procedure" TEXT NOT NULL DEFAULT 'MANUAL',
    "deadline_minutes" INTEGER NOT NULL DEFAULT 60,
    "absence_limit" INTEGER NOT NULL DEFAULT 10,
    "consecutive_limit" INTEGER NOT NULL DEFAULT 3,
    "time_zone" TEXT NOT NULL DEFAULT 'Africa/Luanda',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_settings_single" CHECK ("id" = 1),
    CONSTRAINT "attendance_settings_model_check" CHECK ("teacher_model" IN ('PER_LESSON', 'PER_DAY')),
    CONSTRAINT "attendance_settings_procedure_check" CHECK ("missing_procedure" IN ('MANUAL', 'AUTOMATIC')),
    CONSTRAINT "attendance_settings_deadline_check" CHECK ("deadline_minutes" BETWEEN 30 AND 240),
    CONSTRAINT "attendance_settings_absence_check" CHECK ("absence_limit" BETWEEN 1 AND 200),
    CONSTRAINT "attendance_settings_consecutive_check" CHECK ("consecutive_limit" BETWEEN 2 AND 30)
);
