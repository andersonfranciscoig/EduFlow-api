-- DOCUMENTOS (D7): cartões de estudante.
--   student_card_settings  a escolha do colégio (uma linha): um dos três modelos da plataforma
--                          (Clássico, Moderno, Contemporâneo) e a personalização (cores, contactos, QR, verso)
--   student_photos         a fotografia do aluno carregada pela secretaria (cifrada no armazenamento do
--                          colégio), para quem não a entregou na inscrição
--   student_cards          cada cartão emitido (por aluno e ano letivo, com versões: a segunda via
--                          substitui a anterior), com a cópia dos dados impressos e o código de verificação

CREATE TABLE "student_card_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    -- CLASSICO | MODERNO | CONTEMPORANEO
    "model" TEXT NOT NULL DEFAULT 'CLASSICO',
    "primary_color" TEXT NOT NULL DEFAULT '#0f3d33',
    "accent_color" TEXT NOT NULL DEFAULT '#c9a227',
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "show_qr" BOOLEAN NOT NULL DEFAULT true,
    "back_note" TEXT,
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3),
    CONSTRAINT "student_card_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_card_settings_single_check" CHECK ("id" = 1),
    CONSTRAINT "student_card_settings_model_check" CHECK ("model" IN ('CLASSICO', 'MODERNO', 'CONTEMPORANEO')),
    CONSTRAINT "student_card_settings_colors_check" CHECK ("primary_color" ~ '^#[0-9a-f]{6}$' AND "accent_color" ~ '^#[0-9a-f]{6}$')
);

CREATE TABLE "student_photos" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "uploaded_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_photos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_photos_mime_check" CHECK ("mime_type" IN ('image/jpeg', 'image/png'))
);
CREATE INDEX "student_photos_student_idx" ON "student_photos"("student_id", "created_at");
ALTER TABLE "student_photos" ADD CONSTRAINT "student_photos_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "student_cards" (
    "id" UUID NOT NULL,
    -- n.º de emissão (sequência do colégio)
    "number" SERIAL NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    -- o código impresso e do QR (a página de verificação só diz se é válido)
    "code" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    -- a cópia do que foi impresso (aluno, colégio, cores, fotografia): reimprimir dá o mesmo cartão
    "data" JSONB NOT NULL,
    "valid_until" DATE NOT NULL,
    -- ACTIVE | REPLACED (segunda via) | REVOKED (anulado: perdido, saída do aluno…)
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "revoke_reason" TEXT,
    "request_id" UUID,
    "created_by_id" UUID,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    CONSTRAINT "student_cards_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_cards_version_check" CHECK ("version" >= 1),
    CONSTRAINT "student_cards_model_check" CHECK ("model" IN ('CLASSICO', 'MODERNO', 'CONTEMPORANEO')),
    CONSTRAINT "student_cards_status_check" CHECK ("status" IN ('ACTIVE', 'REPLACED', 'REVOKED'))
);
CREATE UNIQUE INDEX "student_cards_number_key" ON "student_cards"("number");
CREATE UNIQUE INDEX "student_cards_code_key" ON "student_cards"("code");
CREATE UNIQUE INDEX "student_cards_version_key" ON "student_cards"("student_id", "academic_year_id", "version");
-- um só cartão válido por aluno e ano letivo
CREATE UNIQUE INDEX "student_cards_active_key" ON "student_cards"("student_id", "academic_year_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "student_cards_year_idx" ON "student_cards"("academic_year_id", "status");
CREATE INDEX "student_cards_request_idx" ON "student_cards"("request_id") WHERE "request_id" IS NOT NULL;
ALTER TABLE "student_cards" ADD CONSTRAINT "student_cards_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_cards" ADD CONSTRAINT "student_cards_year_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "student_cards" ADD CONSTRAINT "student_cards_request_fkey" FOREIGN KEY ("request_id") REFERENCES "document_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
