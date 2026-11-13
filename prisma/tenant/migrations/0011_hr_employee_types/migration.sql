-- =============================================================================
--  RECURSOS HUMANOS — tipos de funcionário
--
--  hr_employee_types   tipos definidos pelo colégio (ex.: Docente, Administrativo,
--                      Auxiliar). Cada cadastro é de um tipo, e o formulário mostra
--                      só os campos e documentos desse tipo.
--  employee_type_ids   em cada campo e tipo de documento: a que tipos se aplica.
--                      Vazio = a todos os tipos (o caso normal dos campos comuns).
--
--  Um tipo usado por campos ou documentos não se elimina (desativa-se): retirá-lo
--  da lista faria esses campos passarem a valer para todos sem ninguém decidir.
-- =============================================================================
CREATE TABLE "hr_employee_types" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hr_employee_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hr_employee_types_name_check" CHECK (char_length("name") BETWEEN 2 AND 60),
    CONSTRAINT "hr_employee_types_description_check" CHECK ("description" IS NULL OR char_length("description") <= 240)
);
CREATE UNIQUE INDEX "hr_employee_types_name_key" ON "hr_employee_types"(lower("name"));

ALTER TABLE "hr_form_fields" ADD COLUMN "employee_type_ids" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "hr_document_types" ADD COLUMN "employee_type_ids" UUID[] NOT NULL DEFAULT '{}';
-- "que campos/documentos usam este tipo?"
CREATE INDEX "hr_form_fields_types_idx" ON "hr_form_fields" USING GIN ("employee_type_ids");
CREATE INDEX "hr_document_types_types_idx" ON "hr_document_types" USING GIN ("employee_type_ids");
