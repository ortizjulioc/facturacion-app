-- CreateEnum
CREATE TYPE "FiscalState" AS ENUM ('PENDING', 'SENT', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "sendToDgii" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "fiscal_submission" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "state" "FiscalState" NOT NULL DEFAULT 'PENDING',
    "trackId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "dgiiCode" INTEGER,
    "dgiiStatus" TEXT,
    "messages" JSONB,
    "sequenceUsed" BOOLEAN,
    "receivedAt" TEXT,
    "sentAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_submission_documentId_key" ON "fiscal_submission"("documentId");

-- CreateIndex
CREATE INDEX "fiscal_submission_state_nextAttemptAt_idx" ON "fiscal_submission"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "fiscal_submission_organizationId_state_idx" ON "fiscal_submission"("organizationId", "state");

-- AddForeignKey
ALTER TABLE "fiscal_submission" ADD CONSTRAINT "fiscal_submission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_submission" ADD CONSTRAINT "fiscal_submission_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ───────────── Row-Level Security ─────────────
-- Además del aislamiento por empresa, el trabajador que envía a la DGII (un proceso, no una petición de un usuario)
-- necesita ver la cola de TODAS las empresas para saber qué toca procesar. Lo hace declarando `app.system`
-- (solo lo fija el código del trabajador, nunca una petición): con eso solo se alcanza esta tabla.
ALTER TABLE "fiscal_submission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fiscal_submission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fiscal_submission"
  USING ("organizationId" = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'fiscal-worker')
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'fiscal-worker');
