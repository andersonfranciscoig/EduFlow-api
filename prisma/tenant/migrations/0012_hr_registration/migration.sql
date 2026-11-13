-- =============================================================================
--  RECURSOS HUMANOS — pedidos de cadastro e convites
--
--  employee_registration_requests  quem pede para se cadastrar (página pública do
--                                  colégio): nome, email, telefone, função pretendida e
--                                  palavra-passe (só o hash bcrypt). PENDING → APPROVED /
--                                  REJECTED / CANCELLED. Um pedido em aberto por email.
--  employee_registration_invites   convite enviado ao aprovar: o link leva um token
--                                  aleatório; aqui só fica o SHA-256 dele. Tem validade;
--                                  reenviar revoga o anterior (um ativo por pedido).
--  employee_approval_history       quem decidiu o quê, quando, de que estado para qual e
--                                  porquê (pedidos agora; cadastros na fase seguinte).
-- =============================================================================
CREATE TABLE "employee_registration_requests" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    -- função pretendida (indicada pela pessoa; o RH confirma ou corrige ao aprovar)
    "employee_type_id" UUID,
    -- PENDING | APPROVED | REJECTED | CANCELLED
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_registration_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_registration_requests_type_fkey" FOREIGN KEY ("employee_type_id") REFERENCES "hr_employee_types"("id") ON DELETE SET NULL,
    CONSTRAINT "employee_registration_requests_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "employee_registration_requests_name_check" CHECK (char_length("full_name") BETWEEN 3 AND 120),
    CONSTRAINT "employee_registration_requests_email_check" CHECK ("email" = lower("email") AND char_length("email") <= 254),
    CONSTRAINT "employee_registration_requests_reason_check" CHECK ("decision_reason" IS NULL OR char_length("decision_reason") <= 500)
);
-- um pedido em aberto (pendente ou aprovado) por email
CREATE UNIQUE INDEX "employee_registration_requests_open_email_key" ON "employee_registration_requests"("email") WHERE "status" IN ('PENDING', 'APPROVED');
CREATE INDEX "employee_registration_requests_status_idx" ON "employee_registration_requests"("status", "created_at");

CREATE TABLE "employee_registration_invites" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    -- SHA-256 (hex) do token do link; o token em claro só existe no email
    "token_hash" TEXT NOT NULL,
    -- tipo de funcionário confirmado pelo RH (o formulário mostra os campos deste tipo)
    "employee_type_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "send_error" TEXT,
    "revoked_at" TIMESTAMP(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_registration_invites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_registration_invites_request_fkey" FOREIGN KEY ("request_id") REFERENCES "employee_registration_requests"("id") ON DELETE CASCADE,
    CONSTRAINT "employee_registration_invites_type_fkey" FOREIGN KEY ("employee_type_id") REFERENCES "hr_employee_types"("id") ON DELETE SET NULL,
    CONSTRAINT "employee_registration_invites_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "employee_registration_invites_token_key" ON "employee_registration_invites"("token_hash");
-- um convite ativo por pedido (reenviar revoga o anterior)
CREATE UNIQUE INDEX "employee_registration_invites_active_key" ON "employee_registration_invites"("request_id") WHERE "revoked_at" IS NULL;

CREATE TABLE "employee_approval_history" (
    "id" UUID NOT NULL,
    -- REQUEST (pedido de cadastro) | EMPLOYEE (cadastro, fase seguinte)
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_id" UUID,
    -- nome de quem decidiu, no momento (a conta pode mudar ou desaparecer)
    "actor_name" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_approval_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_approval_history_subject_check" CHECK ("subject_type" IN ('REQUEST', 'EMPLOYEE')),
    CONSTRAINT "employee_approval_history_reason_check" CHECK ("reason" IS NULL OR char_length("reason") <= 500)
);
CREATE INDEX "employee_approval_history_subject_idx" ON "employee_approval_history"("subject_type", "subject_id", "created_at");
