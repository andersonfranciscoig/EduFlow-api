-- =============================================================================
--  VAGAS — quantos alunos cada classe pode receber no ano letivo, e quem as ocupa
--
--  Lugares de uma classe   = soma da lotação das suas turmas
--  Vagas                   = "vacancies" definido pela direção (nunca acima dos lugares);
--                            vazio = usar os lugares
--  Ocupadas                = reservas CONFIRMED (aluno colocado numa turma)
--  Reservadas              = reservas HELD ainda dentro do prazo (inscrição em curso)
--  Disponíveis             = vagas − ocupadas − reservadas
--
--  As escritas que mexem nestes números bloqueiam a linha da classe (FOR UPDATE)
--  no school-api: duas inscrições ao mesmo tempo nunca ultrapassam as vagas.
-- =============================================================================
ALTER TABLE "school_classes" ADD COLUMN "vacancies" INTEGER;
ALTER TABLE "school_classes" ADD CONSTRAINT "school_classes_vacancies_check" CHECK ("vacancies" IS NULL OR "vacancies" >= 0);

CREATE TABLE "seat_reservations" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    -- turma onde o aluno ficou (obrigatória quando CONFIRMED; fica como histórico ao libertar)
    "group_id" UUID,
    "status" TEXT NOT NULL,
    -- quem ocupa a vaga (ex.: n.º da inscrição) — sem dados pessoais aqui
    "reference" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "seat_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "seat_reservations_status_check" CHECK ("status" IN ('HELD', 'CONFIRMED', 'RELEASED')),
    CONSTRAINT "seat_reservations_confirmed_group_check" CHECK ("status" <> 'CONFIRMED' OR "group_id" IS NOT NULL),
    CONSTRAINT "seat_reservations_held_expiry_check" CHECK ("status" <> 'HELD' OR "expires_at" IS NOT NULL),
    CONSTRAINT "seat_reservations_reference_check" CHECK (char_length("reference") BETWEEN 1 AND 60),
    CONSTRAINT "seat_reservations_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE,
    CONSTRAINT "seat_reservations_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE CASCADE,
    CONSTRAINT "seat_reservations_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE SET NULL
);
CREATE INDEX "seat_reservations_class_status_idx" ON "seat_reservations"("class_id", "status");
CREATE INDEX "seat_reservations_year_status_idx" ON "seat_reservations"("academic_year_id", "status");
-- a mesma inscrição não ocupa duas vagas na mesma classe
CREATE UNIQUE INDEX "seat_reservations_active_reference_key" ON "seat_reservations"("class_id", lower("reference")) WHERE "status" IN ('HELD', 'CONFIRMED');
