-- Área pedagógica: ano letivo → classes → turmas (tudo dentro de um ano letivo)

CREATE TABLE "academic_years" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "created_by_id" UUID,
    "activated_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "academic_years_dates_check" CHECK ("ends_on" > "starts_on"),
    CONSTRAINT "academic_years_status_check" CHECK ("status" IN ('PLANNED', 'ACTIVE', 'CLOSED'))
);
CREATE UNIQUE INDEX "academic_years_name_key" ON "academic_years"(lower("name"));
-- no máximo UM ano letivo ativo
CREATE UNIQUE INDEX "academic_years_one_active" ON "academic_years"((true)) WHERE "status" = 'ACTIVE';
CREATE INDEX "academic_years_starts_on_idx" ON "academic_years"("starts_on");

CREATE TABLE "school_classes" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    -- 0 = Iniciação; 1–6 Primário; 7–9 I Ciclo; 10–13 II Ciclo
    "grade" INTEGER NOT NULL,
    "course" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "school_classes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "school_classes_grade_check" CHECK ("grade" BETWEEN 0 AND 13),
    CONSTRAINT "school_classes_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "school_classes_year_grade_course_key" ON "school_classes"("academic_year_id", "grade", lower(coalesce("course", '')));

CREATE TABLE "class_groups" (
    "id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "shift" TEXT NOT NULL,
    "room" TEXT,
    "capacity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "class_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "class_groups_shift_check" CHECK ("shift" IN ('MANHA', 'TARDE', 'NOITE')),
    CONSTRAINT "class_groups_capacity_check" CHECK ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 200),
    CONSTRAINT "class_groups_class_fkey" FOREIGN KEY ("class_id") REFERENCES "school_classes"("id") ON DELETE CASCADE,
    CONSTRAINT "class_groups_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "class_groups_class_name_key" ON "class_groups"("class_id", lower("name"));
CREATE INDEX "class_groups_year_idx" ON "class_groups"("academic_year_id");
