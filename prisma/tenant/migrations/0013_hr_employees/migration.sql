-- =============================================================================
--  RECURSOS HUMANOS — cadastro de funcionários
--
--  employees            o cadastro: fica preso à versão do formulário com que começou
--                       (form_version_id). Dados pessoais e secções em JSONB, validados
--                       pela API contra essa versão — o colégio muda os campos sem
--                       alterar esta tabela. Nome, email, telefone, cargo e departamento
--                       repetem-se em colunas para listar e pesquisar.
--                       DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE ⇄ SUSPENDED → TERMINATED
--                                     ↘ CORRECTION_REQUIRED (volta ao funcionário) / REJECTED
--                       revision: gravação automática com concorrência otimista.
--                       number: n.º de funcionário, atribuído ao aprovar (único no colégio).
--  employee_documents   ficheiros entregues (fotografia, documentos pedidos, campos do
--                       tipo ficheiro). O conteúdo está cifrado no armazenamento externo;
--                       aqui só a chave interna, o nome original, o tipo e o tamanho.
--  convites             sessão do formulário (token aleatório; aqui só o SHA-256) e aviso
--                       de convite expirado enviado ao RH (uma vez).
-- =============================================================================
CREATE SEQUENCE "employee_number_seq" START 1;

CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "number" INTEGER,
    "request_id" UUID,
    "employee_type_id" UUID,
    "form_version_id" UUID NOT NULL,
    -- DRAFT | PENDING_APPROVAL | CORRECTION_REQUIRED | APPROVED | REJECTED | ACTIVE | SUSPENDED | TERMINATED
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    -- NOT_STARTED | IN_PROGRESS | SUBMITTED
    "progress" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "last_step" TEXT,
    "completed_steps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 0,
    "personal" JSONB NOT NULL DEFAULT '{}',
    "sections" JSONB NOT NULL DEFAULT '{}',
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "job_title" TEXT,
    "department" TEXT,
    "correction_note" TEXT,
    "created_by_id" UUID,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "terminated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employees_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employees_request_fkey" FOREIGN KEY ("request_id") REFERENCES "employee_registration_requests"("id") ON DELETE SET NULL,
    CONSTRAINT "employees_type_fkey" FOREIGN KEY ("employee_type_id") REFERENCES "hr_employee_types"("id") ON DELETE SET NULL,
    CONSTRAINT "employees_version_fkey" FOREIGN KEY ("form_version_id") REFERENCES "hr_form_versions"("id") ON DELETE RESTRICT,
    CONSTRAINT "employees_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
    CONSTRAINT "employees_progress_check" CHECK ("progress" IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED')),
    CONSTRAINT "employees_number_check" CHECK ("number" IS NULL OR "number" > 0),
    CONSTRAINT "employees_name_check" CHECK (char_length("full_name") BETWEEN 1 AND 120),
    CONSTRAINT "employees_email_check" CHECK ("email" IS NULL OR ("email" = lower("email") AND char_length("email") <= 254)),
    CONSTRAINT "employees_admin_check" CHECK (char_length(coalesce("job_title", '')) <= 120 AND char_length(coalesce("department", '')) <= 120),
    CONSTRAINT "employees_note_check" CHECK ("correction_note" IS NULL OR char_length("correction_note") <= 500)
);
CREATE UNIQUE INDEX "employees_number_key" ON "employees"("number");
-- um cadastro por pedido
CREATE UNIQUE INDEX "employees_request_key" ON "employees"("request_id");
CREATE INDEX "employees_status_idx" ON "employees"("status", "created_at");
CREATE INDEX "employees_type_idx" ON "employees"("employee_type_id");

CREATE TABLE "employee_documents" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    -- PHOTO (fotografia) | DOCUMENT (documento pedido) | FIELD (campo do tipo ficheiro)
    "slot" TEXT NOT NULL,
    -- id do documento ou do campo na versão do formulário (nulo na fotografia)
    "item_id" UUID,
    -- nome do documento/campo no momento da entrega
    "label" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    -- quem entregou: nulo = o próprio funcionário (pelo convite); senão, o utilizador do RH
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_documents_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "employee_documents_slot_check" CHECK ("slot" IN ('PHOTO', 'DOCUMENT', 'FIELD')),
    CONSTRAINT "employee_documents_item_check" CHECK (("slot" = 'PHOTO') = ("item_id" IS NULL)),
    CONSTRAINT "employee_documents_size_check" CHECK ("size" > 0 AND "size" <= 20971520),
    CONSTRAINT "employee_documents_name_check" CHECK (char_length("file_name") BETWEEN 1 AND 200)
);
CREATE INDEX "employee_documents_employee_idx" ON "employee_documents"("employee_id", "slot", "created_at");
-- uma fotografia por funcionário
CREATE UNIQUE INDEX "employee_documents_photo_key" ON "employee_documents"("employee_id") WHERE "slot" = 'PHOTO';

ALTER TABLE "employee_registration_invites"
    ADD COLUMN "session_hash" TEXT,
    ADD COLUMN "session_expires_at" TIMESTAMP(3),
    ADD COLUMN "expired_notified_at" TIMESTAMP(3),
    ADD CONSTRAINT "employee_registration_invites_session_check" CHECK ("session_hash" IS NULL OR "session_hash" ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX "employee_registration_invites_session_key" ON "employee_registration_invites"("session_hash");
