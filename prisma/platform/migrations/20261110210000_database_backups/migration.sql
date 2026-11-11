-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('MANUAL', 'AUTOMATIC');

-- AlterTable
ALTER TABLE "database_servers" ADD COLUMN     "used_bytes" BIGINT;

-- AlterTable
ALTER TABLE "tenant_databases" ADD COLUMN     "size_bytes" BIGINT,
ADD COLUMN     "size_measured_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "database_backups" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "server_id" UUID,
    "trigger" "BackupTrigger" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID,
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "database_bytes" BIGINT,
    "sha256" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "database_backups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "database_backups_school_id_created_at_idx" ON "database_backups"("school_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "database_backups_status_created_at_idx" ON "database_backups"("status", "created_at");

-- AddForeignKey
ALTER TABLE "database_backups" ADD CONSTRAINT "database_backups_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

