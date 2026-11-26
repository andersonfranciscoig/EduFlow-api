-- DOCUMENTOS (D1–D3): tipos de documento configuráveis por colégio, pedidos (família e funcionários)
-- com a máquina de estados, o histórico só de acrescentar e o registo das entregas.
--
--   document_types              o que se pode pedir: público (aluno/funcionário), departamento
--                               (secretaria, pedagogia, RH), método (automático/externo), levantamento
--                               e/ou download, prazo, aprovação, campos extra. Com pedidos, desativa-se.
--   document_requests           cada pedido (DOC-<ano>-<n.º>), com a cópia do tipo e do beneficiário
--                               no momento do pedido (o que se pediu não muda se o tipo mudar)
--   document_request_events     cada passo e cada nota (só de acrescentar)
--   document_deliveries         quem levantou, a relação com o beneficiário, quem entregou e quando

CREATE TABLE "document_types" (
    "id" UUID NOT NULL,
    "audience" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "requirements" TEXT,
    "method" TEXT NOT NULL DEFAULT 'EXTERNAL',
    "pickup" BOOLEAN NOT NULL DEFAULT true,
    "download" BOOLEAN NOT NULL DEFAULT false,
    "fee" INTEGER,
    "sla_days" INTEGER NOT NULL DEFAULT 3,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_types_audience_check" CHECK ("audience" IN ('STUDENT', 'EMPLOYEE')),
    CONSTRAINT "document_types_department_check" CHECK ("department" IN ('SECRETARIA', 'PEDAGOGIA', 'RH')),
    -- os documentos dos funcionários são do RH; os dos alunos, da secretaria ou da pedagogia
    CONSTRAINT "document_types_department_audience_check" CHECK (("audience" = 'EMPLOYEE') = ("department" = 'RH')),
    CONSTRAINT "document_types_method_check" CHECK ("method" IN ('AUTO', 'EXTERNAL')),
    CONSTRAINT "document_types_delivery_check" CHECK ("pickup" OR "download"),
    CONSTRAINT "document_types_fee_check" CHECK ("fee" IS NULL OR "fee" > 0),
    CONSTRAINT "document_types_sla_check" CHECK ("sla_days" BETWEEN 0 AND 90)
);
CREATE UNIQUE INDEX "document_types_name_key" ON "document_types"("audience", lower("name"));

CREATE SEQUENCE "document_request_number_seq";

CREATE TABLE "document_requests" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL DEFAULT nextval('document_request_number_seq'),
    "year" INTEGER NOT NULL,
    "type_id" UUID NOT NULL,
    "type_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "pickup" BOOLEAN NOT NULL,
    "download" BOOLEAN NOT NULL,
    "requires_approval" BOOLEAN NOT NULL,
    "fee" INTEGER,
    "student_id" UUID,
    "employee_id" UUID,
    "beneficiary" JSONB NOT NULL,
    "requester_kind" TEXT NOT NULL,
    "requester_account_id" UUID,
    "requester_user_id" UUID,
    "requester_name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "due_on" DATE,
    "reject_reason" TEXT,
    "cancel_reason" TEXT,
    "handled_by_id" UUID,
    "handled_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "document_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_requests_status_check" CHECK ("status" IN ('PENDING', 'IN_REVIEW', 'AWAITING_PAYMENT', 'PROCESSING', 'READY_PICKUP', 'READY_DOWNLOAD', 'COMPLETED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "document_requests_requester_check" CHECK ("requester_kind" IN ('FAMILY', 'EMPLOYEE', 'STAFF')),
    CONSTRAINT "document_requests_relationship_check" CHECK ("relationship" IN ('SELF', 'GUARDIAN', 'STAFF')),
    -- o beneficiário é um aluno (documentos escolares) ou um funcionário (profissionais), nunca os dois
    CONSTRAINT "document_requests_beneficiary_check" CHECK (("audience" = 'STUDENT' AND "student_id" IS NOT NULL AND "employee_id" IS NULL) OR ("audience" = 'EMPLOYEE' AND "employee_id" IS NOT NULL AND "student_id" IS NULL))
);
CREATE UNIQUE INDEX "document_requests_number_key" ON "document_requests"("number");
CREATE INDEX "document_requests_status_idx" ON "document_requests"("audience", "status", "created_at" DESC);
CREATE INDEX "document_requests_student_idx" ON "document_requests"("student_id", "created_at" DESC);
CREATE INDEX "document_requests_employee_idx" ON "document_requests"("employee_id", "created_at" DESC);
CREATE INDEX "document_requests_type_idx" ON "document_requests"("type_id");
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_type_fkey" FOREIGN KEY ("type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_student_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_employee_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "document_request_events" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    -- STATUS (mudança de estado) | NOTE (nota)
    "kind" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "note" TEXT,
    -- nota interna: só a equipa a vê
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "actor_kind" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "document_request_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_request_events_kind_check" CHECK ("kind" IN ('STATUS', 'NOTE')),
    CONSTRAINT "document_request_events_actor_check" CHECK ("actor_kind" IN ('FAMILY', 'EMPLOYEE', 'STAFF', 'SYSTEM'))
);
CREATE INDEX "document_request_events_request_idx" ON "document_request_events"("request_id", "at");
ALTER TABLE "document_request_events" ADD CONSTRAINT "document_request_events_request_fkey" FOREIGN KEY ("request_id") REFERENCES "document_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION document_request_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'document_request_events é só de acrescentar';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER document_request_events_no_update BEFORE UPDATE OR DELETE ON "document_request_events" FOR EACH ROW EXECUTE FUNCTION document_request_events_append_only();

CREATE TABLE "document_deliveries" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "received_by" TEXT NOT NULL,
    "received_by_document" TEXT,
    "relationship" TEXT NOT NULL,
    "delivered_by_id" UUID,
    "delivered_by_name" TEXT,
    "delivered_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    CONSTRAINT "document_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_deliveries_received_check" CHECK (length(btrim("received_by")) >= 3)
);
CREATE UNIQUE INDEX "document_deliveries_request_key" ON "document_deliveries"("request_id");
ALTER TABLE "document_deliveries" ADD CONSTRAINT "document_deliveries_request_fkey" FOREIGN KEY ("request_id") REFERENCES "document_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
