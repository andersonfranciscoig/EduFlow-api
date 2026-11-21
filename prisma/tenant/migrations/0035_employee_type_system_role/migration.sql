-- =============================================================================
--  PAPEL NO SISTEMA POR TIPO DE FUNCIONÁRIO.
--
--  hr_employee_types.system_role   o acesso ao portal que a ficha pode dar a quem é deste tipo:
--      PROFESSOR  conta de professor (como até aqui — é o valor dos tipos que já existem)
--      RH         conta só da área dos Recursos Humanos (school_users.role = 'RH'; só o
--                 responsável do colégio a dá)
--      NONE       sem acesso ao sistema (limpeza, segurança, cozinha…)
--  Os tipos "Auxiliar…" já existentes (a sugestão de limpeza/segurança) passam a NONE.
--  As contas que já existem não mudam.
--
--  SchoolRole ganha 'RH' (papel do portal só com a área dos Recursos Humanos). O valor não é
--  usado nesta migração (o PostgreSQL não deixa usar um valor novo na mesma transação).
-- =============================================================================
ALTER TYPE "SchoolRole" ADD VALUE IF NOT EXISTS 'RH';
ALTER TABLE "hr_employee_types" ADD COLUMN "system_role" TEXT NOT NULL DEFAULT 'PROFESSOR';
ALTER TABLE "hr_employee_types" ADD CONSTRAINT "hr_employee_types_system_role_check" CHECK ("system_role" IN ('PROFESSOR', 'RH', 'NONE'));
UPDATE "hr_employee_types" SET "system_role" = 'NONE' WHERE lower("name") LIKE 'auxiliar%';
