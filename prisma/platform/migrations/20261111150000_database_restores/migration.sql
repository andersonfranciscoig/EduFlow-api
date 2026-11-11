-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- AlterEnum
ALTER TYPE "BackupTrigger" ADD VALUE 'PRE_RESTORE';

-- CreateTable
CREATE TABLE "database_restores" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "backup_id" UUID NOT NULL,
    "status" "RestoreStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "safety_backup_id" UUID,
    "rolled_back" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "database_restores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "database_restores_school_id_created_at_idx" ON "database_restores"("school_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "database_restores_status_created_at_idx" ON "database_restores"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "database_backups_id_school_id_key" ON "database_backups"("id", "school_id");

-- AddForeignKey
ALTER TABLE "database_restores" ADD CONSTRAINT "database_restores_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_restores" ADD CONSTRAINT "database_restores_backup_id_school_id_fkey" FOREIGN KEY ("backup_id", "school_id") REFERENCES "database_backups"("id", "school_id") ON DELETE RESTRICT ON UPDATE CASCADE;

