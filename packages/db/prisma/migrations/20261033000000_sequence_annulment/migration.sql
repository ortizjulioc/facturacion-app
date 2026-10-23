-- CreateEnum
CREATE TYPE "AnnulmentState" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "sequence_annulment" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sequenceId" UUID,
    "ecfType" "EcfType" NOT NULL,
    "fromNumber" BIGINT NOT NULL,
    "toNumber" BIGINT NOT NULL,
    "count" INTEGER NOT NULL,
    "state" "AnnulmentState" NOT NULL DEFAULT 'PENDING',
    "wasActive" BOOLEAN NOT NULL,
    "xml" TEXT,
    "responseCode" TEXT,
    "responseMessages" JSONB,
    "error" TEXT,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "sequence_annulment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sequence_annulment_organizationId_createdAt_idx" ON "sequence_annulment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "sequence_annulment_sequenceId_state_idx" ON "sequence_annulment"("sequenceId", "state");

-- AddForeignKey
ALTER TABLE "sequence_annulment" ADD CONSTRAINT "sequence_annulment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_annulment" ADD CONSTRAINT "sequence_annulment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequence"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Row-Level Security ─────────────
ALTER TABLE "sequence_annulment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequence_annulment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sequence_annulment"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));
