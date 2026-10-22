-- AlterTable
ALTER TABLE "document" ADD COLUMN     "ecfXml" TEXT,
ADD COLUMN     "securityCode" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "company_certificate" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "secret" BYTEA NOT NULL,
    "subject" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_certificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_certificate_organizationId_key" ON "company_certificate"("organizationId");

-- AddForeignKey
ALTER TABLE "company_certificate" ADD CONSTRAINT "company_certificate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ───────────── Row-Level Security ─────────────
ALTER TABLE "company_certificate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_certificate" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_certificate"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── La firma de un comprobante se agrega una sola vez ─────────────
-- Un comprobante emitido sin certificado (p. ej. una venta de la caja sin conexión) se puede firmar después,
-- pero una vez firmado ni el XML, ni el código de seguridad, ni la fecha de firma vuelven a cambiar.
CREATE OR REPLACE FUNCTION document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Un comprobante emitido no se puede eliminar';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'Un comprobante emitido no puede volver a borrador';
    END IF;
    IF OLD."signedAt" IS NOT NULL AND (
      NEW."ecfXml" IS DISTINCT FROM OLD."ecfXml"
      OR NEW."securityCode" IS DISTINCT FROM OLD."securityCode"
      OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt"
    ) THEN
      RAISE EXCEPTION 'La firma de un comprobante no se puede modificar';
    END IF;
    -- Solo el estado fiscal y la firma pueden avanzar; cualquier otro dato queda congelado.
    IF (to_jsonb(NEW) - ARRAY['status', 'updatedAt', 'ecfXml', 'securityCode', 'signedAt'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updatedAt', 'ecfXml', 'securityCode', 'signedAt']) THEN
      RAISE EXCEPTION 'Un comprobante emitido no se puede modificar';
    END IF;
  END IF;
  RETURN NEW;
END $$;
