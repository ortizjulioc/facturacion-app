-- CreateEnum
CREATE TYPE "PurchaseKind" AS ENUM ('SUPPLIER_INVOICE', 'E41', 'E43');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'POSTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EcfType" ADD VALUE 'E41';
ALTER TYPE "EcfType" ADD VALUE 'E43';

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "lastCost" BIGINT;

-- AlterTable
ALTER TABLE "stock_movement" ADD COLUMN     "purchaseId" UUID;

-- CreateTable
CREATE TABLE "supplier" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentType" "DocumentType",
    "documentNumber" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "PurchaseKind" NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "branchId" UUID NOT NULL,
    "supplierId" UUID,
    "supplierName" TEXT,
    "supplierDocType" "DocumentType",
    "supplierDocNumber" TEXT,
    "ncf" TEXT,
    "invoiceDate" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'DOP',
    "exchangeRate" DECIMAL(14,4) NOT NULL DEFAULT 1,
    "expenseType" INTEGER NOT NULL DEFAULT 9,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "notes" TEXT,
    "totalDiscount" BIGINT NOT NULL DEFAULT 0,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "base18" BIGINT NOT NULL DEFAULT 0,
    "tax18" BIGINT NOT NULL DEFAULT 0,
    "base16" BIGINT NOT NULL DEFAULT 0,
    "tax16" BIGINT NOT NULL DEFAULT 0,
    "base0" BIGINT NOT NULL DEFAULT 0,
    "baseExempt" BIGINT NOT NULL DEFAULT 0,
    "totalTax" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "itbisWithheld" BIGINT NOT NULL DEFAULT 0,
    "isrWithheld" BIGINT NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_line" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purchaseId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'UND',
    "quantity" BIGINT NOT NULL,
    "unitCost" BIGINT NOT NULL,
    "priceIncludesTax" BOOLEAN NOT NULL,
    "tax" "TaxCode" NOT NULL,
    "discountType" TEXT,
    "discountValue" BIGINT,
    "gross" BIGINT NOT NULL,
    "discount" BIGINT NOT NULL,
    "base" BIGINT NOT NULL,
    "taxAmount" BIGINT NOT NULL,
    "total" BIGINT NOT NULL,

    CONSTRAINT "purchase_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_organizationId_name_idx" ON "supplier"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_organizationId_documentNumber_key" ON "supplier"("organizationId", "documentNumber");

-- CreateIndex
CREATE INDEX "purchase_organizationId_status_idx" ON "purchase"("organizationId", "status");

-- CreateIndex
CREATE INDEX "purchase_organizationId_invoiceDate_idx" ON "purchase"("organizationId", "invoiceDate");

-- CreateIndex
CREATE INDEX "purchase_supplierId_idx" ON "purchase"("supplierId");

-- CreateIndex
CREATE INDEX "purchase_branchId_idx" ON "purchase"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_organizationId_supplierId_ncf_key" ON "purchase"("organizationId", "supplierId", "ncf");

-- CreateIndex
CREATE INDEX "purchase_line_productId_idx" ON "purchase_line"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_line_purchaseId_lineNumber_key" ON "purchase_line"("purchaseId", "lineNumber");

-- CreateIndex
CREATE INDEX "stock_movement_purchaseId_idx" ON "stock_movement"("purchaseId");

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchase"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ───────────── Los comprobantes de VENTA siguen siendo solo E31–E34 ─────────────
-- (E41 y E43 existen únicamente para numerar las compras de la empresa).
ALTER TABLE "document" ADD CONSTRAINT "document_type_sales_chk" CHECK ("type" IN ('E31', 'E32', 'E33', 'E34'));

-- ───────────── Restricciones de las compras ─────────────
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_expense_type_chk" CHECK ("expenseType" BETWEEN 1 AND 11);
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_amounts_chk" CHECK (
  "total" >= 0 AND "subtotal" >= 0 AND "totalTax" >= 0 AND "totalDiscount" >= 0
  AND "itbisWithheld" >= 0 AND "isrWithheld" >= 0
  AND "itbisWithheld" <= "totalTax" AND "isrWithheld" <= "subtotal"
);
-- Formato del NCF según el tipo de compra.
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_ncf_chk" CHECK (
  "ncf" IS NULL
  OR ("kind" = 'SUPPLIER_INVOICE' AND "ncf" ~ '^(B[0-9]{10}|E[0-9]{12})$')
  OR ("kind" = 'E41' AND "ncf" ~ '^E41[0-9]{10}$')
  OR ("kind" = 'E43' AND "ncf" ~ '^E43[0-9]{10}$')
);
-- Una compra registrada siempre tiene NCF y fecha de registro; un borrador no.
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_posted_chk" CHECK (
  ("status" = 'DRAFT' AND "postedAt" IS NULL)
  OR ("status" = 'POSTED' AND "postedAt" IS NOT NULL AND "ncf" IS NOT NULL)
);
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_amounts_chk" CHECK (
  "quantity" > 0 AND "unitCost" >= 0 AND "total" >= 0
);
-- El e-NCF que emite la empresa (E41/E43) nunca se repite dentro de la empresa.
-- (El NCF de un proveedor sí puede coincidir con el de otro proveedor: ese es único por proveedor.)
CREATE UNIQUE INDEX "purchase_own_encf_uq" ON "purchase" ("organizationId", "ncf") WHERE "kind" IN ('E41', 'E43');

-- ───────────── Row-Level Security ─────────────
ALTER TABLE "supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "supplier"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "purchase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "purchase_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_line" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_line"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── Una compra registrada queda congelada ─────────────
-- (Los borrados en cascada, p. ej. al eliminar una empresa, llegan con pg_trigger_depth() > 1.)
CREATE FUNCTION purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Una compra registrada no se puede eliminar';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'Una compra registrada no se puede modificar';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_guard BEFORE UPDATE OR DELETE ON "purchase"
  FOR EACH ROW EXECUTE FUNCTION purchase_guard();

CREATE FUNCTION purchase_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status "PurchaseStatus";
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "status" INTO parent_status FROM "purchase"
    WHERE "id" = COALESCE(NEW."purchaseId", OLD."purchaseId");
  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Las líneas de una compra registrada no se pueden modificar';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER purchase_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "purchase_line"
  FOR EACH ROW EXECUTE FUNCTION purchase_line_guard();

-- ───────────── Claves foráneas diferibles (ver migración fk_deferrable) ─────────────
ALTER TABLE "purchase" ALTER CONSTRAINT "purchase_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "purchase" ALTER CONSTRAINT "purchase_supplierId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "purchase_line" ALTER CONSTRAINT "purchase_line_productId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "stock_movement" ALTER CONSTRAINT "stock_movement_purchaseId_fkey" DEFERRABLE INITIALLY DEFERRED;
