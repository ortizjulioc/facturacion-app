-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('NONE', 'PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "received_document" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "emitterRnc" TEXT NOT NULL,
    "emitterName" TEXT,
    "ecfType" TEXT NOT NULL,
    "encf" TEXT NOT NULL,
    "issuedOn" DATE NOT NULL,
    "total" BIGINT NOT NULL,
    "totalItbis" BIGINT NOT NULL DEFAULT 0,
    "xml" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "securityCode" TEXT,
    "signedAtText" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackXml" TEXT NOT NULL,
    "approved" BOOLEAN,
    "approvalReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "approvalXml" TEXT,
    "approvalState" "ApprovalState" NOT NULL DEFAULT 'NONE',
    "peerSentAt" TIMESTAMP(3),
    "peerError" TEXT,
    "dgiiSentAt" TIMESTAMP(3),
    "dgiiError" TEXT,
    "approvalAttempts" INTEGER NOT NULL DEFAULT 0,
    "approvalNextAt" TIMESTAMP(3),
    "approvalLockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "received_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issued_approval" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "reason" TEXT,
    "approvedAtText" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "xml" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issued_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "received_document_organizationId_receivedAt_idx" ON "received_document"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "received_document_approvalState_approvalNextAt_idx" ON "received_document"("approvalState", "approvalNextAt");

-- CreateIndex
CREATE UNIQUE INDEX "received_document_organizationId_emitterRnc_encf_key" ON "received_document"("organizationId", "emitterRnc", "encf");

-- CreateIndex
CREATE UNIQUE INDEX "issued_approval_documentId_key" ON "issued_approval"("documentId");

-- AddForeignKey
ALTER TABLE "received_document" ADD CONSTRAINT "received_document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issued_approval" ADD CONSTRAINT "issued_approval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issued_approval" ADD CONSTRAINT "issued_approval_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ───────────── Row-Level Security ─────────────
-- received_document: igual que la cola fiscal, el trabajador (app.system = 'fiscal-worker') ve todas las empresas para
-- entregar las aprobaciones pendientes.
ALTER TABLE "received_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "received_document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "received_document"
  USING ("organizationId" = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'fiscal-worker')
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'fiscal-worker');

ALTER TABLE "issued_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issued_approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "issued_approval"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- Los servicios públicos de recepción (/fe/...) reciben un e-CF sin sesión: la empresa destinataria se encuentra por su
-- RNC. Esta política SOLO permite LEER los datos fiscales, y solo a quien declara app.system = 'receiver'
-- (lo fija únicamente el código de esos servicios, nunca una petición de un usuario).
CREATE POLICY receiver_lookup ON "company_profile" FOR SELECT
  USING (current_setting('app.system', true) = 'receiver');
