-- =============================================================================
--  MATRÍCULAS — fase E.
--  admission_config      configuração do colégio (uma linha): quem confirma a matrícula
--                        (STAFF secretaria · FAMILY a família · AUTO ao aprovar), formato do
--                        n.º de matrícula (prefixo, com o ano, algarismos) e quantos dias a vaga
--                        fica guardada depois da aprovação (se o ano não tiver período de matrículas).
--  enrollment_counters   último n.º de matrícula por ano letivo (a linha bloqueia-se: n.º únicos).
--  enrollments           a matrícula de um aluno num ano: classe, turma, turno, a vaga (reserva
--                        CONFIRMED), quem a fez e, numa exceção (sem vaga), o motivo.
--                        Uma matrícula ativa por aluno e ano.
--  applications.seat_reservation_id   a vaga guardada ao aprovar (reserva HELD).
-- =============================================================================
CREATE TABLE "admission_config" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "enrollment_mode" TEXT NOT NULL DEFAULT 'STAFF',
    "number_prefix" TEXT NOT NULL DEFAULT 'MAT',
    "number_with_year" BOOLEAN NOT NULL DEFAULT true,
    "number_digits" INTEGER NOT NULL DEFAULT 5,
    "hold_days" INTEGER NOT NULL DEFAULT 15,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "admission_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admission_config_single" CHECK ("id" = 1),
    CONSTRAINT "admission_config_mode_check" CHECK ("enrollment_mode" IN ('STAFF', 'FAMILY', 'AUTO')),
    CONSTRAINT "admission_config_prefix_check" CHECK ("number_prefix" ~ '^[A-Z0-9]{0,8}$'),
    CONSTRAINT "admission_config_digits_check" CHECK ("number_digits" BETWEEN 3 AND 8),
    CONSTRAINT "admission_config_hold_check" CHECK ("hold_days" BETWEEN 1 AND 90)
);

CREATE TABLE "enrollment_counters" (
    "academic_year_id" UUID NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "enrollment_counters_pkey" PRIMARY KEY ("academic_year_id")
);
ALTER TABLE "enrollment_counters" ADD CONSTRAINT "enrollment_counters_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "student_id" UUID NOT NULL,
    "application_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "group_id" UUID,
    "shift" TEXT,
    "seat_reservation_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    -- STAFF (secretaria) | FAMILY (a família confirmou) | AUTO (ao aprovar)
    "by_kind" TEXT NOT NULL,
    "by_id" UUID,
    "by_name" TEXT,
    "exception_reason" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "enrollments_status_check" CHECK ("status" IN ('ACTIVE', 'CANCELLED')),
    CONSTRAINT "enrollments_by_check" CHECK ("by_kind" IN ('STAFF', 'FAMILY', 'AUTO')),
    CONSTRAINT "enrollments_shift_check" CHECK ("shift" IS NULL OR "shift" IN ('MANHA', 'TARDE', 'NOITE'))
);
CREATE UNIQUE INDEX "enrollments_number_key" ON "enrollments"("number");
CREATE UNIQUE INDEX "enrollments_application_key" ON "enrollments"("application_id");
CREATE UNIQUE INDEX "enrollments_active_student_year_key" ON "enrollments"("student_id", "academic_year_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "enrollments_year_class_idx" ON "enrollments"("academic_year_id", "class_id");
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_application_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_group_fkey" FOREIGN KEY ("group_id") REFERENCES "class_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_seat_fkey" FOREIGN KEY ("seat_reservation_id") REFERENCES "seat_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "applications" ADD COLUMN "seat_reservation_id" UUID;
ALTER TABLE "applications" ADD CONSTRAINT "applications_seat_fkey" FOREIGN KEY ("seat_reservation_id") REFERENCES "seat_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
