-- Suporte EduFlow: autorização dada pelo colégio + registo de cada entrada
CREATE TABLE "support_grants" (
    "id" UUID NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "support_grants_expires_at_idx" ON "support_grants"("expires_at");

CREATE TABLE "support_sessions" (
    "id" UUID NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "staff_id" UUID NOT NULL,
    "staff_name" TEXT NOT NULL,
    "staff_email" TEXT,
    "mode" TEXT NOT NULL,
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "grant_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_sessions_mode_check" CHECK ("mode" IN ('READ', 'WRITE'))
);
CREATE UNIQUE INDEX "support_sessions_ticket_id_key" ON "support_sessions"("ticket_id");
CREATE INDEX "support_sessions_created_at_idx" ON "support_sessions"("created_at");
