-- =============================================================================
--  INSCRIÇÕES — fase D: análise pela secretaria.
--  application_history.steps: os passos que a família tem de corrigir (pedido de correções).
--  Índice para a lista da secretaria (por estado e data de submissão).
-- =============================================================================
ALTER TABLE "application_history" ADD COLUMN "steps" TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX "applications_status_submitted_idx" ON "applications"("status", "submitted_at");
