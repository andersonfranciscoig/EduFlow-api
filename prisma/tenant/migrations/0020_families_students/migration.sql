-- =============================================================================
--  FAMÍLIAS — contas de família, alunos, encarregados e a relação entre eles
--
--  family_accounts      contas das famílias (encarregados e alunos maiores de idade),
--                       SEPARADAS das contas da equipa (school_users): email + senha +
--                       código por email a cada entrada. Nunca recebem permissões de gestão.
--  family_codes         códigos de 6 dígitos (só o hash): ativação, entrada, recuperação.
--  family_sessions      sessões revogáveis das contas de família.
--  guardians            encarregados de educação (podem não ter conta).
--  students             alunos: entidade académica, distinta de qualquer conta. O aluno
--                       maior de idade pode ser titular da sua conta (account_id).
--                       number: n.º de aluno, atribuído na matrícula.
--  student_guardians    quem é quem para cada aluno: parentesco, encarregado principal,
--                       contacto de emergência, responsável financeiro e se gere o aluno.
--                       Um só encarregado principal por aluno.
--  Uma pessoa pode ser encarregada de um aluno e aluna ela própria (a mesma conta).
-- =============================================================================
CREATE TABLE "family_accounts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    -- PENDING (por ativar) | ACTIVE | SUSPENDED
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "family_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_accounts_status_check" CHECK ("status" IN ('PENDING', 'ACTIVE', 'SUSPENDED')),
    CONSTRAINT "family_accounts_email_check" CHECK ("email" = lower("email") AND char_length("email") <= 254),
    CONSTRAINT "family_accounts_name_check" CHECK (char_length("full_name") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "family_accounts_email_key" ON "family_accounts"("email");

CREATE TABLE "family_codes" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    -- ACTIVATION | LOGIN | RECOVERY
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "family_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_codes_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE CASCADE,
    CONSTRAINT "family_codes_purpose_check" CHECK ("purpose" IN ('ACTIVATION', 'LOGIN', 'RECOVERY'))
);
CREATE INDEX "family_codes_account_idx" ON "family_codes"("account_id", "purpose", "created_at");

CREATE TABLE "family_sessions" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "family_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_sessions_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE CASCADE
);
CREATE INDEX "family_sessions_account_idx" ON "family_sessions"("account_id");

CREATE TABLE "guardians" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    -- dados do encarregado (campos fixos validados pela API contra a versão do formulário)
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "guardians_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE SET NULL,
    CONSTRAINT "guardians_name_check" CHECK (char_length("full_name") BETWEEN 1 AND 120)
);
-- uma conta é, no máximo, um encarregado (que pode ter vários educandos)
CREATE UNIQUE INDEX "guardians_account_key" ON "guardians"("account_id") WHERE "account_id" IS NOT NULL;

CREATE SEQUENCE "student_number_seq" START 1;

CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "number" INTEGER,
    -- aluno maior de idade titular da sua conta
    "account_id" UUID,
    "full_name" TEXT NOT NULL,
    "birth_date" DATE NOT NULL,
    "gender" TEXT,
    -- dados pessoais do aluno (campos fixos validados pela API contra a versão do formulário)
    "data" JSONB NOT NULL DEFAULT '{}',
    -- CANDIDATE (inscrito, ainda sem matrícula) | ENROLLED | SUSPENDED | TRANSFERRED | LEFT | GRADUATED
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "students_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "students_account_fkey" FOREIGN KEY ("account_id") REFERENCES "family_accounts"("id") ON DELETE SET NULL,
    CONSTRAINT "students_status_check" CHECK ("status" IN ('CANDIDATE', 'ENROLLED', 'SUSPENDED', 'TRANSFERRED', 'LEFT', 'GRADUATED')),
    CONSTRAINT "students_number_check" CHECK ("number" IS NULL OR "number" > 0),
    CONSTRAINT "students_name_check" CHECK (char_length("full_name") BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX "students_number_key" ON "students"("number") WHERE "number" IS NOT NULL;
CREATE UNIQUE INDEX "students_account_key" ON "students"("account_id") WHERE "account_id" IS NOT NULL;
CREATE INDEX "students_name_idx" ON "students"(lower("full_name"));

CREATE TABLE "student_guardians" (
    "student_id" UUID NOT NULL,
    "guardian_id" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "relationship_other" TEXT,
    -- encarregado de educação principal (um só por aluno)
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "is_financial" BOOLEAN NOT NULL DEFAULT false,
    -- gere o aluno na área da família (só enquanto o aluno for menor, salvo autorização)
    "can_manage" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "student_guardians_pkey" PRIMARY KEY ("student_id", "guardian_id"),
    CONSTRAINT "student_guardians_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE,
    CONSTRAINT "student_guardians_guardian_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardians"("id") ON DELETE CASCADE,
    CONSTRAINT "student_guardians_relationship_check" CHECK ("relationship" IN ('Pai', 'Mãe', 'Avô', 'Avó', 'Tio', 'Tia', 'Irmão', 'Irmã', 'Tutor legal', 'Outro')),
    CONSTRAINT "student_guardians_other_check" CHECK (("relationship" = 'Outro') = ("relationship_other" IS NOT NULL))
);
CREATE UNIQUE INDEX "student_guardians_primary_key" ON "student_guardians"("student_id") WHERE "is_primary";
CREATE INDEX "student_guardians_guardian_idx" ON "student_guardians"("guardian_id");
