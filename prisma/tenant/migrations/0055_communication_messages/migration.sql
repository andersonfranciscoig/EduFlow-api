-- COMUNICAÇÃO (C2 + C3): mensagens individuais e grupos.
--   conversations         uma conversa: DIRECT (duas pessoas; uma só por par) ou GROUP (manual ou ligado a
--                         uma turma, classe, departamento ou à instituição, com os membros sincronizados)
--   conversation_members  quem participa: papel (ADMIN | MEMBER), de onde veio (MANUAL | SYNC), o que já leu,
--                         até onde recebeu (entregue), se arquivou; quem sai fica com left_at (o histórico fica)
--   messages              as mensagens (o texto não vai para a auditoria)
--   message_files         anexos (imagens e documentos, cifrados no armazenamento do colégio; só pela API)
-- communication_settings: quem pode falar com quem e quem cria grupos (por colégio)

ALTER TABLE "communication_settings"
  ADD COLUMN "students_message" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "staff_message" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "teachers_create_groups" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    -- DIRECT | GROUP
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    -- grupos: MANUAL | CLASS (turma) | GRADE (classe) | DEPARTMENT | INSTITUTION
    "group_type" TEXT,
    "ref_id" UUID,
    "ref_text" TEXT,
    -- grupos ligados: GUARDIANS | TEACHERS | STUDENTS | STAFF | ALL
    "audience" TEXT,
    "only_admins_post" BOOLEAN NOT NULL DEFAULT false,
    "members_can_add" BOOLEAN NOT NULL DEFAULT false,
    -- DIRECT: as duas pessoas por ordem ("STAFF:<id>|FAMILY:<id>"), para haver uma só conversa por par
    "direct_key" TEXT,
    "created_by_kind" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_message_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),
    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversations_kind_check" CHECK ("kind" IN ('DIRECT', 'GROUP')),
    CONSTRAINT "conversations_group_type_check" CHECK ("group_type" IS NULL OR "group_type" IN ('MANUAL', 'CLASS', 'GRADE', 'DEPARTMENT', 'INSTITUTION')),
    CONSTRAINT "conversations_audience_check" CHECK ("audience" IS NULL OR "audience" IN ('GUARDIANS', 'TEACHERS', 'STUDENTS', 'STAFF', 'ALL'))
);
CREATE UNIQUE INDEX "conversations_direct_key" ON "conversations" ("direct_key") WHERE "direct_key" IS NOT NULL;
CREATE INDEX "conversations_last_idx" ON "conversations" ("last_message_at");

CREATE TABLE "conversation_members" (
    "conversation_id" UUID NOT NULL,
    -- STAFF (conta do portal) | FAMILY (encarregado ou aluno maior)
    "member_kind" TEXT NOT NULL,
    "member_id" UUID NOT NULL,
    "member_name" TEXT NOT NULL,
    -- porque está (ex.: "Professor de Matemática · 7.ª B"), para os outros saberem quem é
    "label" TEXT,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "joined_at" TIMESTAMP(3) NOT NULL,
    "left_at" TIMESTAMP(3),
    "last_read_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id", "member_kind", "member_id"),
    CONSTRAINT "conversation_members_conversation_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "conversation_members_kind_check" CHECK ("member_kind" IN ('STAFF', 'FAMILY')),
    CONSTRAINT "conversation_members_role_check" CHECK ("role" IN ('ADMIN', 'MEMBER')),
    CONSTRAINT "conversation_members_source_check" CHECK ("source" IN ('MANUAL', 'SYNC'))
);
CREATE INDEX "conversation_members_person_idx" ON "conversation_members" ("member_kind", "member_id");

CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    -- TEXT | SYSTEM (ex.: "Ana entrou no grupo")
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "sender_kind" TEXT,
    "sender_id" UUID,
    "sender_name" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "messages_conversation_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "messages_kind_check" CHECK ("kind" IN ('TEXT', 'SYSTEM'))
);
CREATE INDEX "messages_conversation_idx" ON "messages" ("conversation_id", "created_at");

CREATE TABLE "message_files" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_files_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "message_files_message_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE,
    CONSTRAINT "message_files_mime_check" CHECK ("mime_type" IN ('application/pdf', 'image/jpeg', 'image/png'))
);
CREATE INDEX "message_files_message_idx" ON "message_files" ("message_id");

-- a fotografia de perfil que cada pessoa escolhe (equipa ou família; JPG ou PNG, cifrada); sem ela, o aluno
-- usa a da inscrição (ou a carregada pela secretaria) e os outros as iniciais. Trocar não apaga a anterior.
CREATE TABLE "profile_photos" (
    "party_kind" TEXT NOT NULL,
    "party_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "profile_photos_pkey" PRIMARY KEY ("party_kind", "party_id"),
    CONSTRAINT "profile_photos_kind_check" CHECK ("party_kind" IN ('STAFF', 'FAMILY')),
    CONSTRAINT "profile_photos_mime_check" CHECK ("mime_type" IN ('image/jpeg', 'image/png'))
);
