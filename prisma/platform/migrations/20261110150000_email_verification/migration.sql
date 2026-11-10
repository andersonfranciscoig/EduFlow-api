-- CreateEnum
CREATE TYPE "EmailVerificationPurpose" AS ENUM ('STAFF_SIGN_UP', 'STAFF_PASSWORD_RESET', 'SCHOOL_SIGN_UP', 'SCHOOL_PASSWORD_RESET', 'SCHOOL_EMAIL_CHANGE');

-- AlterEnum
ALTER TYPE "SchoolStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "owner_email_deadline" TIMESTAMP(3),
ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_from_status" "SchoolStatus",
ADD COLUMN     "suspension_reason" TEXT;

-- AlterTable
ALTER TABLE "tenant_provisioning_jobs" ADD COLUMN     "provisioned_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL,
    "purpose" "EmailVerificationPurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "proof_hash" TEXT,
    "proof_expires_at" TIMESTAMP(3),
    "proof_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_proof_hash_key" ON "email_verifications"("proof_hash");

-- CreateIndex
CREATE INDEX "email_verifications_purpose_email_created_at_idx" ON "email_verifications"("purpose", "email", "created_at" DESC);


-- Colégios cuja BD já existe: ficam marcados (nunca mais podem "mudar de servidor" por engano)
UPDATE "tenant_provisioning_jobs" AS j SET "provisioned_at" = td."created_at"
FROM "tenant_databases" AS td WHERE td."school_id" = j."school_id" AND j."provisioned_at" IS NULL;
