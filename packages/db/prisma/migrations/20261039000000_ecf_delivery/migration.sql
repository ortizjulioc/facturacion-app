-- Entrega del e-CF al comprador que también es contribuyente electrónico (Informe Técnico e-CF, pág. 12: pasos 1–4).
-- Tras la aceptación de la DGII, el emisor envía el e-CF al servicio de recepción del comprador y guarda su acuse.

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'DELIVERED', 'NOT_RECEIVED', 'NOT_ELECTRONIC', 'FAILED');
-- CreateTable
CREATE TABLE "ecf_delivery" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "buyerRnc" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "ackXml" TEXT,
    "ackStatus" INTEGER,
    "ackReason" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ecf_delivery_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "ecf_delivery_documentId_key" ON "ecf_delivery"("documentId");
-- CreateIndex
CREATE INDEX "ecf_delivery_state_nextAttemptAt_idx" ON "ecf_delivery"("state", "nextAttemptAt");
-- CreateIndex
CREATE INDEX "ecf_delivery_organizationId_state_idx" ON "ecf_delivery"("organizationId", "state");
-- AddForeignKey
ALTER TABLE "ecf_delivery" ADD CONSTRAINT "ecf_delivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "ecf_delivery" ADD CONSTRAINT "ecf_delivery_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Row-Level Security ─────────────
-- Igual que la cola fiscal: el trabajador (app.system = 'fiscal-worker') ve todas las empresas para entregar lo pendiente.
ALTER TABLE "ecf_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ecf_delivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ecf_delivery"
  USING ("organizationId" = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'fiscal-worker')
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'fiscal-worker');
