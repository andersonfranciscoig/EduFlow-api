-- AlterTable
ALTER TABLE "staff_members" ADD COLUMN     "extra_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "staff_activity" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "actor_id" UUID,
    "details" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_activity_subject_id_occurred_at_idx" ON "staff_activity"("subject_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "staff_activity_actor_id_occurred_at_idx" ON "staff_activity"("actor_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "staff_activity" ADD CONSTRAINT "staff_activity_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "staff_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_activity" ADD CONSTRAINT "staff_activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "staff_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
