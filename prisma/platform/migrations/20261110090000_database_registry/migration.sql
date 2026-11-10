-- CreateEnum
CREATE TYPE "DatabaseServerKind" AS ENUM ('SHARED_SERVER', 'DEDICATED_DATABASE');

-- CreateEnum
CREATE TYPE "DatabaseServerStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DatabaseServerHealth" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "DatabaseCheckKind" AS ENUM ('REGISTRATION', 'MANUAL', 'PERIODIC');

-- CreateEnum
CREATE TYPE "DatabaseCheckStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE');

-- CreateEnum
CREATE TYPE "DatabaseAllocationStatus" AS ENUM ('RESERVED', 'ASSIGNED', 'RELEASED', 'EXPIRED');

-- DropIndex
DROP INDEX "tenant_databases_db_name_key";

-- AlterTable
ALTER TABLE "tenant_databases" ADD COLUMN     "server_id" UUID,
ADD COLUMN     "ssl_mode" TEXT NOT NULL DEFAULT 'disable';

-- AlterTable
ALTER TABLE "tenant_provisioning_jobs" ADD COLUMN     "server_id" UUID;

-- CreateTable
CREATE TABLE "database_servers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DatabaseServerKind" NOT NULL,
    "status" "DatabaseServerStatus" NOT NULL DEFAULT 'ACTIVE',
    "region" TEXT,
    "notes" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ssl_mode" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "health" "DatabaseServerHealth" NOT NULL DEFAULT 'UNKNOWN',
    "last_checked_at" TIMESTAMP(3),
    "last_latency_ms" INTEGER,
    "server_version" TEXT,
    "tls_active" BOOLEAN,
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "credentials_updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_server_secrets" (
    "server_id" UUID NOT NULL,
    "url_ciphertext" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_server_secrets_pkey" PRIMARY KEY ("server_id")
);

-- CreateTable
CREATE TABLE "database_server_checks" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "kind" "DatabaseCheckKind" NOT NULL,
    "status" "DatabaseCheckStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID,
    "ok" BOOLEAN,
    "connect_ms" INTEGER,
    "latency_ms" INTEGER,
    "server_version" TEXT,
    "tls" BOOLEAN,
    "details" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "database_server_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_allocations" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "status" "DatabaseAllocationStatus" NOT NULL,
    "reserved_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "assigned_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,
    "actor_staff_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_server_activity" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_staff_id" UUID,
    "details" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_server_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "database_servers_endpoint_key" ON "database_servers"("endpoint");

-- CreateIndex
CREATE INDEX "database_servers_status_kind_idx" ON "database_servers"("status", "kind");

-- CreateIndex
CREATE INDEX "database_server_checks_server_id_created_at_idx" ON "database_server_checks"("server_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "database_server_checks_status_created_at_idx" ON "database_server_checks"("status", "created_at");

-- CreateIndex
CREATE INDEX "database_allocations_server_id_status_idx" ON "database_allocations"("server_id", "status");

-- CreateIndex
CREATE INDEX "database_allocations_school_id_status_idx" ON "database_allocations"("school_id", "status");

-- CreateIndex
CREATE INDEX "database_server_activity_server_id_occurred_at_idx" ON "database_server_activity"("server_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_databases_db_host_db_port_db_name_key" ON "tenant_databases"("db_host", "db_port", "db_name");

-- AddForeignKey
ALTER TABLE "tenant_provisioning_jobs" ADD CONSTRAINT "tenant_provisioning_jobs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "database_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_server_secrets" ADD CONSTRAINT "database_server_secrets_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "database_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_server_checks" ADD CONSTRAINT "database_server_checks_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "database_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_allocations" ADD CONSTRAINT "database_allocations_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "database_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_allocations" ADD CONSTRAINT "database_allocations_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_server_activity" ADD CONSTRAINT "database_server_activity_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "database_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integridade (não gerido pelo Prisma): no máximo UMA reserva/atribuição ativa por colégio
CREATE UNIQUE INDEX "database_allocations_one_active_per_school" ON "database_allocations"("school_id") WHERE "status" IN ('RESERVED', 'ASSIGNED');
