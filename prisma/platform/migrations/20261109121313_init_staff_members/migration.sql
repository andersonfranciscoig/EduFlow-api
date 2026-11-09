-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('ADMIN', 'GESTOR');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "staff_members" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "status" "StaffStatus" NOT NULL,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_email_key" ON "staff_members"("email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_members_phone_key" ON "staff_members"("phone");
