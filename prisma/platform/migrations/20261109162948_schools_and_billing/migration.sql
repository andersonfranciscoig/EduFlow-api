-- CreateEnum
CREATE TYPE "SchoolStatus" AS ENUM ('PENDING_REVIEW', 'AWAITING_PAYMENT', 'PAYMENT_UNDER_REVIEW', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_REVIEW', 'AWAITING_PAYMENT', 'PROOF_SUBMITTED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('REFERENCE', 'TRANSFER');

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "monthly_price" INTEGER NOT NULL,
    "max_students" INTEGER,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "quarterly_discount_pct" INTEGER NOT NULL,
    "annual_discount_pct" INTEGER NOT NULL,
    "reference_entity" TEXT NOT NULL,
    "reference_provider" TEXT NOT NULL,
    "reference_validity_days" INTEGER NOT NULL,
    "transfer_instructions" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL,
    "bank_name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "swift" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schools" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nif" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "municipality" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "owner_name" TEXT NOT NULL,
    "owner_email" TEXT NOT NULL,
    "owner_password_hash" TEXT NOT NULL,
    "status" "SchoolStatus" NOT NULL,
    "rejection_reason" TEXT,
    "subscription_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_orders" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "school_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_name" TEXT NOT NULL,
    "plan_monthly_price" INTEGER NOT NULL,
    "cycle" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discount_pct" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "payment_method" "PaymentMethod",
    "reference_entity" TEXT,
    "reference_number" TEXT,
    "reference_expires_at" TIMESTAMP(3),
    "bank_name" TEXT,
    "bank_holder" TEXT,
    "bank_iban" TEXT,
    "transaction_number" TEXT,
    "proof_key" TEXT,
    "proof_file_name" TEXT,
    "proof_mime_type" TEXT,
    "proof_submitted_at" TIMESTAMP(3),
    "proof_rejection_reason" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_activity" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor_staff_id" UUID,
    "details" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_iban_key" ON "bank_accounts"("iban");

-- CreateIndex
CREATE UNIQUE INDEX "schools_nif_key" ON "schools"("nif");

-- CreateIndex
CREATE UNIQUE INDEX "schools_owner_email_key" ON "schools"("owner_email");

-- CreateIndex
CREATE INDEX "schools_status_idx" ON "schools"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_orders_number_key" ON "subscription_orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_orders_reference_number_key" ON "subscription_orders"("reference_number");

-- CreateIndex
CREATE INDEX "subscription_orders_school_id_created_at_idx" ON "subscription_orders"("school_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "school_activity_school_id_occurred_at_idx" ON "school_activity"("school_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "subscription_orders" ADD CONSTRAINT "subscription_orders_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_activity" ADD CONSTRAINT "school_activity_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
