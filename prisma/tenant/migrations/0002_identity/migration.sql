-- Identidade do colégio: utilizadores, sessões, códigos por email e histórico.
-- Aplicada pelo provisioner a CADA BD de colégio (ver tenant-migrator.ts).

-- CreateEnum
CREATE TYPE "SchoolRole" AS ENUM ('DIRETOR', 'SECRETARIA', 'PROFESSOR');

-- CreateEnum
CREATE TYPE "SchoolUserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "EmailCodePurpose" AS ENUM ('ACTIVATION', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "school_users" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT,
    "role" "SchoolRole" NOT NULL,
    "status" "SchoolUserStatus" NOT NULL,
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "mfa_secret_ciphertext" TEXT,
    "mfa_pending_secret_ciphertext" TEXT,
    "mfa_enabled_at" TIMESTAMP(3),
    "mfa_last_used_step" INTEGER,
    "mfa_recovery_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "mfa_verified_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "school_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "EmailCodePurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_activity" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "actor_id" UUID,
    "details" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "school_users_email_key" ON "school_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "school_users_phone_key" ON "school_users"("phone");

-- Um só responsável por colégio (não representável no schema.prisma)
CREATE UNIQUE INDEX "school_users_single_owner" ON "school_users"("is_owner") WHERE "is_owner";

-- CreateIndex
CREATE INDEX "school_sessions_user_id_idx" ON "school_sessions"("user_id");

-- CreateIndex
CREATE INDEX "email_codes_user_id_purpose_created_at_idx" ON "email_codes"("user_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "school_activity_subject_id_occurred_at_idx" ON "school_activity"("subject_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "school_sessions" ADD CONSTRAINT "school_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "school_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_codes" ADD CONSTRAINT "email_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "school_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
