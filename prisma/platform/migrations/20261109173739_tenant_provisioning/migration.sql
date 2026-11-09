-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "slug" TEXT;

-- CreateTable
CREATE TABLE "tenant_provisioning_jobs" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "school_name" TEXT NOT NULL,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_provisioning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_databases" (
    "school_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "school_name" TEXT NOT NULL,
    "db_host" TEXT NOT NULL,
    "db_port" INTEGER NOT NULL,
    "db_name" TEXT NOT NULL,
    "db_user" TEXT NOT NULL,
    "password_ciphertext" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_databases_pkey" PRIMARY KEY ("school_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_provisioning_jobs_school_id_key" ON "tenant_provisioning_jobs"("school_id");

-- CreateIndex
CREATE INDEX "tenant_provisioning_jobs_status_created_at_idx" ON "tenant_provisioning_jobs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_slug_key" ON "tenant_databases"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_db_name_key" ON "tenant_databases"("db_name");

-- CreateIndex
CREATE UNIQUE INDEX "schools_slug_key" ON "schools"("slug");

-- AddForeignKey
ALTER TABLE "tenant_provisioning_jobs" ADD CONSTRAINT "tenant_provisioning_jobs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_databases" ADD CONSTRAINT "tenant_databases_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

