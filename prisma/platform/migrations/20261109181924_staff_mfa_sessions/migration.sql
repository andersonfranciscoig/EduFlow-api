-- AlterTable
ALTER TABLE "staff_members" ADD COLUMN     "mfa_enabled_at" TIMESTAMP(3),
ADD COLUMN     "mfa_last_used_step" INTEGER,
ADD COLUMN     "mfa_pending_secret_ciphertext" TEXT,
ADD COLUMN     "mfa_recovery_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mfa_secret_ciphertext" TEXT;

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "mfa_verified_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_sessions_staff_id_revoked_at_idx" ON "staff_sessions"("staff_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

