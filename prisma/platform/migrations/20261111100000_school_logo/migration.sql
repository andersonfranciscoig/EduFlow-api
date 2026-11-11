-- Logótipo do colégio (público): chave no armazenamento + URL
ALTER TABLE "schools" ADD COLUMN "logo_key" TEXT;
ALTER TABLE "schools" ADD COLUMN "logo_url" TEXT;
ALTER TABLE "schools" ADD COLUMN "logo_updated_at" TIMESTAMP(3);
