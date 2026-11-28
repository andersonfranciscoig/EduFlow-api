-- COMUNICAÇÃO (C1): avisos institucionais.
--   communication_settings   a configuração do colégio (uma linha): os diretores de turma podem publicar para as suas turmas
--   announcement_categories  as categorias do colégio (as sugeridas entram já; arquivam-se, não se apagam)
--   announcements            cada aviso: rascunho → agendado → publicado → arquivado, prioridade, fixar, confirmação de leitura, expiração
--   announcement_targets     os destinatários escolhidos (grupos, turmas, classes, departamentos, pessoas)
--   announcement_recipients  quem o recebe de facto, sem repetidos (uma pessoa em vários grupos conta uma vez),
--                            calculado na publicação: entregue (notificação), visto e confirmado
--   announcement_files       anexos (cifrados no armazenamento do colégio; só pela API)

CREATE TABLE "communication_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "class_directors_publish" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "updated_at" TIMESTAMP(3),
    CONSTRAINT "communication_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "communication_settings_single_check" CHECK ("id" = 1)
);

CREATE TABLE "announcement_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "announcement_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "announcement_categories_name_key" ON "announcement_categories" (lower("name"));
INSERT INTO "announcement_categories" ("id", "name", "position", "created_at") VALUES
  (gen_random_uuid(), 'Geral', 1, now()),
  (gen_random_uuid(), 'Académico', 2, now()),
  (gen_random_uuid(), 'Administrativo', 3, now()),
  (gen_random_uuid(), 'Financeiro', 4, now()),
  (gen_random_uuid(), 'Eventos', 5, now()),
  (gen_random_uuid(), 'Reuniões', 6, now()),
  (gen_random_uuid(), 'Urgente', 7, now());

CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    -- NORMAL | HIGH | URGENT
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    -- DRAFT | SCHEDULED | PUBLISHED | ARCHIVED
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    -- a autoridade usada: ALL (qualquer destinatário) | STAFF (só a equipa) | CLASS (diretor de turma)
    "scope" TEXT NOT NULL,
    "publish_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "requires_ack" BOOLEAN NOT NULL DEFAULT false,
    "author_id" UUID NOT NULL,
    "author_name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "announcements_number_key" UNIQUE ("number"),
    CONSTRAINT "announcements_category_fkey" FOREIGN KEY ("category_id") REFERENCES "announcement_categories"("id") ON DELETE RESTRICT,
    CONSTRAINT "announcements_priority_check" CHECK ("priority" IN ('NORMAL', 'HIGH', 'URGENT')),
    CONSTRAINT "announcements_status_check" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')),
    CONSTRAINT "announcements_scope_check" CHECK ("scope" IN ('ALL', 'STAFF', 'CLASS'))
);
CREATE INDEX "announcements_status_idx" ON "announcements" ("status", "publish_at");
CREATE INDEX "announcements_author_idx" ON "announcements" ("author_id", "created_at");

CREATE TABLE "announcement_targets" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    -- ALL | STUDENTS | GUARDIANS | TEACHERS | STAFF | CLASS | GROUP | DEPARTMENT | USER | FAMILY
    "kind" TEXT NOT NULL,
    -- a classe, a turma, o utilizador ou a conta da família
    "ref_id" UUID,
    -- o departamento (texto livre das fichas)
    "ref_text" TEXT,
    -- turma/classe: STUDENTS | GUARDIANS | BOTH
    "audience" TEXT,
    CONSTRAINT "announcement_targets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "announcement_targets_announcement_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE,
    CONSTRAINT "announcement_targets_kind_check" CHECK ("kind" IN ('ALL', 'STUDENTS', 'GUARDIANS', 'TEACHERS', 'STAFF', 'CLASS', 'GROUP', 'DEPARTMENT', 'USER', 'FAMILY')),
    CONSTRAINT "announcement_targets_audience_check" CHECK ("audience" IS NULL OR "audience" IN ('STUDENTS', 'GUARDIANS', 'BOTH'))
);
CREATE INDEX "announcement_targets_announcement_idx" ON "announcement_targets" ("announcement_id");

CREATE TABLE "announcement_recipients" (
    "announcement_id" UUID NOT NULL,
    -- STAFF (conta do portal) | FAMILY (conta da família: encarregado ou aluno maior)
    "recipient_kind" TEXT NOT NULL,
    "recipient_id" UUID NOT NULL,
    "recipient_name" TEXT NOT NULL,
    -- porque o recebe (ex.: "Encarregado · 8.ª A"), para os indicadores
    "via" TEXT,
    "delivered_at" TIMESTAMP(3),
    "viewed_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    CONSTRAINT "announcement_recipients_pkey" PRIMARY KEY ("announcement_id", "recipient_kind", "recipient_id"),
    CONSTRAINT "announcement_recipients_announcement_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE,
    CONSTRAINT "announcement_recipients_kind_check" CHECK ("recipient_kind" IN ('STAFF', 'FAMILY'))
);
CREATE INDEX "announcement_recipients_person_idx" ON "announcement_recipients" ("recipient_kind", "recipient_id");

CREATE TABLE "announcement_files" (
    "id" UUID NOT NULL,
    "announcement_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "announcement_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "announcement_files_announcement_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE,
    CONSTRAINT "announcement_files_mime_check" CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'))
);
CREATE INDEX "announcement_files_announcement_idx" ON "announcement_files" ("announcement_id");
