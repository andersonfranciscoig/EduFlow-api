-- =============================================================================
--  RECURSOS HUMANOS — contratos dos funcionários
--
--  employee_contracts   um funcionário tem um histórico de contratos (renovações
--                       ficam ligadas ao anterior por previous_id). Dois contratos do
--                       mesmo funcionário não se sobrepõem no tempo (a API confirma).
--                       O estado não se grava: calcula-se pelas datas (hora de Luanda):
--                         futuro → vigente → caducado (ends_on) | rescindido (terminated_on)
--                       base_salary: kwanzas (inteiros); null = por definir. Só quem tem
--                       a permissão hr.contracts.salary o vê ou altera.
--                       Cópia assinada (opcional): cifrada no armazenamento do colégio;
--                       aqui só a chave interna, o nome, o tipo e o tamanho.
-- =============================================================================
CREATE SEQUENCE "contract_number_seq" START 1;

CREATE TABLE "employee_contracts" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "employee_id" UUID NOT NULL,
    -- INDETERMINADO | DETERMINADO | PRESTACAO_SERVICOS | ESTAGIO
    "kind" TEXT NOT NULL,
    -- TEMPO_INTEIRO | TEMPO_PARCIAL
    "regime" TEXT NOT NULL,
    "weekly_hours" INTEGER NOT NULL,
    "job_title" TEXT NOT NULL,
    "department" TEXT,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "trial_ends_on" DATE,
    "base_salary" INTEGER,
    "notes" TEXT,
    "previous_id" UUID,
    "terminated_on" DATE,
    "termination_reason" TEXT,
    "file_name" TEXT,
    "file_mime_type" TEXT,
    "file_size" INTEGER,
    "file_sha256" TEXT,
    "file_storage_key" TEXT,
    "file_uploaded_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_contracts_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE,
    CONSTRAINT "employee_contracts_previous_fkey" FOREIGN KEY ("previous_id") REFERENCES "employee_contracts"("id") ON DELETE SET NULL,
    CONSTRAINT "employee_contracts_kind_check" CHECK ("kind" IN ('INDETERMINADO', 'DETERMINADO', 'PRESTACAO_SERVICOS', 'ESTAGIO')),
    CONSTRAINT "employee_contracts_regime_check" CHECK ("regime" IN ('TEMPO_INTEIRO', 'TEMPO_PARCIAL')),
    CONSTRAINT "employee_contracts_hours_check" CHECK ("weekly_hours" BETWEEN 1 AND 60),
    CONSTRAINT "employee_contracts_job_check" CHECK (char_length("job_title") BETWEEN 2 AND 120 AND char_length(coalesce("department", '')) <= 120),
    -- sem termo não tem fim; a termo e estágio têm fim
    CONSTRAINT "employee_contracts_end_check" CHECK (
        ("kind" = 'INDETERMINADO' AND "ends_on" IS NULL)
        OR ("kind" IN ('DETERMINADO', 'ESTAGIO') AND "ends_on" IS NOT NULL)
        OR "kind" = 'PRESTACAO_SERVICOS'
    ),
    CONSTRAINT "employee_contracts_dates_check" CHECK (
        ("ends_on" IS NULL OR "ends_on" >= "starts_on")
        AND ("trial_ends_on" IS NULL OR "trial_ends_on" >= "starts_on")
        AND ("terminated_on" IS NULL OR "terminated_on" >= "starts_on")
    ),
    CONSTRAINT "employee_contracts_salary_check" CHECK ("base_salary" IS NULL OR "base_salary" BETWEEN 0 AND 1000000000),
    CONSTRAINT "employee_contracts_notes_check" CHECK (char_length(coalesce("notes", '')) <= 1000),
    CONSTRAINT "employee_contracts_termination_check" CHECK (("terminated_on" IS NULL) = ("termination_reason" IS NULL) AND char_length(coalesce("termination_reason", '')) <= 500),
    CONSTRAINT "employee_contracts_file_check" CHECK (("file_storage_key" IS NULL) = ("file_name" IS NULL) AND ("file_size" IS NULL OR "file_size" BETWEEN 1 AND 10485760))
);
CREATE UNIQUE INDEX "employee_contracts_number_key" ON "employee_contracts"("number");
CREATE INDEX "employee_contracts_employee_idx" ON "employee_contracts"("employee_id", "starts_on");
CREATE INDEX "employee_contracts_ends_idx" ON "employee_contracts"("ends_on") WHERE "ends_on" IS NOT NULL;
