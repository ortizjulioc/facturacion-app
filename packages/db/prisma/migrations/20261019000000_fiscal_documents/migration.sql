-- CreateEnum
CREATE TYPE "EcfType" AS ENUM ('E31', 'E32', 'E33', 'E34');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'SIGNED', 'SENT', 'ACCEPTED', 'ACCEPTED_CONDITIONAL', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'CHECK', 'CARD', 'CREDIT', 'OTHER');

-- CreateEnum
CREATE TYPE "EcfEnvironment" AS ENUM ('TEST', 'CERT', 'PROD');

-- CreateTable
CREATE TABLE "company_profile" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rnc" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "address" TEXT NOT NULL,
    "province" TEXT,
    "municipality" TEXT,
    "economicActivity" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "environment" "EcfEnvironment" NOT NULL DEFAULT 'TEST',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ecfType" "EcfType" NOT NULL,
    "fromNumber" BIGINT NOT NULL,
    "toNumber" BIGINT NOT NULL,
    "nextNumber" BIGINT NOT NULL,
    "expiresAt" DATE NOT NULL,
    "terminalId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "EcfType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "encf" TEXT,
    "branchId" UUID NOT NULL,
    "terminalId" UUID,
    "customerId" UUID,
    "buyerName" TEXT,
    "buyerDocType" "DocumentType",
    "buyerDocNumber" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'DOP',
    "exchangeRate" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "propinaLegal" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "referencedDocumentId" UUID,
    "referencedEncf" TEXT,
    "modificationCode" INTEGER,
    "totalDiscount" BIGINT NOT NULL DEFAULT 0,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "base18" BIGINT NOT NULL DEFAULT 0,
    "tax18" BIGINT NOT NULL DEFAULT 0,
    "base16" BIGINT NOT NULL DEFAULT 0,
    "tax16" BIGINT NOT NULL DEFAULT 0,
    "base0" BIGINT NOT NULL DEFAULT 0,
    "baseExempt" BIGINT NOT NULL DEFAULT 0,
    "totalTax" BIGINT NOT NULL DEFAULT 0,
    "propinaAmount" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_line" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'UND',
    "quantity" BIGINT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "priceIncludesTax" BOOLEAN NOT NULL,
    "tax" "TaxCode" NOT NULL,
    "discountType" TEXT,
    "discountValue" BIGINT,
    "gross" BIGINT NOT NULL,
    "discount" BIGINT NOT NULL,
    "base" BIGINT NOT NULL,
    "taxAmount" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,

    CONSTRAINT "document_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_profile_organizationId_key" ON "company_profile"("organizationId");

-- CreateIndex
CREATE INDEX "sequence_organizationId_ecfType_active_idx" ON "sequence"("organizationId", "ecfType", "active");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_organizationId_ecfType_fromNumber_key" ON "sequence"("organizationId", "ecfType", "fromNumber");

-- CreateIndex
CREATE INDEX "document_organizationId_status_idx" ON "document"("organizationId", "status");

-- CreateIndex
CREATE INDEX "document_organizationId_createdAt_idx" ON "document"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "document_customerId_idx" ON "document"("customerId");

-- CreateIndex
CREATE INDEX "document_branchId_idx" ON "document"("branchId");

-- CreateIndex
CREATE INDEX "document_referencedDocumentId_idx" ON "document"("referencedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_organizationId_encf_key" ON "document"("organizationId", "encf");

-- CreateIndex
CREATE INDEX "document_line_productId_idx" ON "document_line"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "document_line_documentId_lineNumber_key" ON "document_line"("documentId", "lineNumber");

-- CreateIndex
CREATE INDEX "payment_documentId_idx" ON "payment"("documentId");

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence" ADD CONSTRAINT "sequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence" ADD CONSTRAINT "sequence_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_referencedDocumentId_fkey" FOREIGN KEY ("referencedDocumentId") REFERENCES "document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_line" ADD CONSTRAINT "document_line_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_line" ADD CONSTRAINT "document_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Restricciones de consistencia ─────────────
ALTER TABLE "sequence" ADD CONSTRAINT "sequence_range_chk" CHECK (
  "fromNumber" >= 1
  AND "fromNumber" <= "toNumber"
  AND "toNumber" <= 9999999999
  AND "nextNumber" >= "fromNumber"
  AND "nextNumber" <= "toNumber" + 1
);

ALTER TABLE "document" ADD CONSTRAINT "document_encf_format_chk" CHECK (
  "encf" IS NULL OR "encf" ~ '^E(31|32|33|34)[0-9]{10}$'
);
-- El tipo del e-NCF (dígitos 2-3) debe coincidir con el tipo del documento.
ALTER TABLE "document" ADD CONSTRAINT "document_encf_type_chk" CHECK (
  "encf" IS NULL OR substring("encf" from 2 for 2) = substring("type"::text from 2 for 2)
);
-- Todo documento que ya no es borrador tiene e-NCF.
ALTER TABLE "document" ADD CONSTRAINT "document_issued_has_encf_chk" CHECK (
  "status" = 'DRAFT' OR "encf" IS NOT NULL
);
ALTER TABLE "document" ADD CONSTRAINT "document_amounts_chk" CHECK (
  "total" >= 0 AND "subtotal" >= 0 AND "totalTax" >= 0 AND "propinaAmount" >= 0 AND "totalDiscount" >= 0
);
ALTER TABLE "document_line" ADD CONSTRAINT "document_line_amounts_chk" CHECK (
  "quantity" > 0 AND "unitPrice" >= 0 AND "total" >= 0
);
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_chk" CHECK ("amount" > 0);

-- ───────────── Row-Level Security (mismo patrón que el resto) ─────────────
ALTER TABLE "company_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_profile"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sequence"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "document_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_line"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── Inmutabilidad de los comprobantes ─────────────
-- Última línea de defensa: aunque un bug de la API intente tocar un comprobante emitido,
-- la base de datos lo rechaza. Los borrados en cascada (p. ej. al eliminar una empresa)
-- llegan desde un trigger de integridad referencial: pg_trigger_depth() > 1.

CREATE FUNCTION document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- Solo el estado fiscal puede avanzar; cualquier otro dato queda congelado.
    IF (to_jsonb(NEW) - ARRAY['status', 'updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updatedAt']) THEN
      RAISE EXCEPTION 'Un comprobante emitido no se puede modificar';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER document_guard BEFORE UPDATE OR DELETE ON "document"
  FOR EACH ROW EXECUTE FUNCTION document_guard();

CREATE FUNCTION document_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_status "DocumentStatus";
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "status" INTO doc_status FROM "document"
    WHERE "id" = COALESCE(NEW."documentId", OLD."documentId");
  IF doc_status IS NOT NULL AND doc_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Las líneas y pagos de un comprobante emitido no se pueden modificar';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER document_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "document_line"
  FOR EACH ROW EXECUTE FUNCTION document_child_guard();
CREATE TRIGGER payment_guard BEFORE INSERT OR UPDATE OR DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION document_child_guard();

-- Las secuencias solo avanzan y un rango en uso no se reescribe ni se borra.
CREATE FUNCTION sequence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."nextNumber" > OLD."fromNumber" AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'No se puede eliminar un rango de secuencia que ya se usó';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."nextNumber" < OLD."nextNumber" THEN
    RAISE EXCEPTION 'Una secuencia no puede retroceder';
  END IF;
  IF OLD."nextNumber" > OLD."fromNumber"
     AND (NEW."fromNumber" <> OLD."fromNumber" OR NEW."ecfType" <> OLD."ecfType") THEN
    RAISE EXCEPTION 'No se puede cambiar el inicio ni el tipo de un rango en uso';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sequence_guard BEFORE UPDATE OR DELETE ON "sequence"
  FOR EACH ROW EXECUTE FUNCTION sequence_guard();
