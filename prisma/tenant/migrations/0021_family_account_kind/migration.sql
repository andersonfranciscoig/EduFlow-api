-- =============================================================================
--  Tipo da conta da família, escolhido ao criar a conta:
--    GUARDIAN  encarregado de educação (inscreve e acompanha educandos menores)
--    STUDENT   aluno maior de idade (trata da própria inscrição)
--  birth_date: obrigatória para STUDENT — o school-api confirma os 18 anos (hora de Luanda).
--  As contas já existentes ficam como encarregado.
-- =============================================================================
ALTER TABLE "family_accounts"
    ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'GUARDIAN',
    ADD COLUMN "birth_date" DATE,
    ADD CONSTRAINT "family_accounts_kind_check" CHECK ("kind" IN ('GUARDIAN', 'STUDENT')),
    ADD CONSTRAINT "family_accounts_student_birth_check" CHECK ("kind" <> 'STUDENT' OR "birth_date" IS NOT NULL);
