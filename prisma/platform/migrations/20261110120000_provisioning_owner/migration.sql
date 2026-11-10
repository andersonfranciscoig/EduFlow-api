-- O pedido de criação da BD do colégio leva o responsável, para o provisioner
-- lhe criar a conta (por ativar) no portal do colégio.
ALTER TABLE "tenant_provisioning_jobs" ADD COLUMN "owner_name" TEXT,
ADD COLUMN "owner_email" TEXT;

UPDATE "tenant_provisioning_jobs" AS j
SET "owner_name" = s."owner_name", "owner_email" = s."owner_email"
FROM "schools" AS s
WHERE s."id" = j."school_id";

-- Colégios já criados voltam à fila: o provisioner aplica-lhes a migração
-- 0002_identity, cria a conta do responsável e roda a senha da BD (idempotente).
UPDATE "tenant_provisioning_jobs" SET "status" = 'PENDING', "attempts" = 0, "updated_at" = now() WHERE "status" = 'DONE';
