-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'SALE', 'RETURN', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "allowNegativeStock" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "minStock" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stock_level" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "unitCost" BIGINT,
    "documentId" UUID,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_level_organizationId_branchId_idx" ON "stock_level"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_level_productId_branchId_key" ON "stock_level"("productId", "branchId");

-- CreateIndex
CREATE INDEX "stock_movement_organizationId_productId_createdAt_idx" ON "stock_movement"("organizationId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movement_organizationId_createdAt_idx" ON "stock_movement"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movement_documentId_idx" ON "stock_movement"("documentId");

-- AddForeignKey
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_level" ADD CONSTRAINT "stock_level_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ───────────── Restricciones ─────────────
ALTER TABLE "product" ADD CONSTRAINT "product_min_stock_chk" CHECK ("minStock" >= 0);
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_qty_chk" CHECK ("quantity" <> 0);
-- Una venta siempre resta y una entrada o un reingreso siempre suman; el ajuste puede ser de cualquier signo.
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_sign_chk" CHECK (
  ("type" = 'SALE' AND "quantity" < 0)
  OR ("type" IN ('RECEIPT', 'RETURN') AND "quantity" > 0)
  OR "type" = 'ADJUSTMENT'
);

-- ───────────── Row-Level Security ─────────────
ALTER TABLE "stock_level" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_level" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_level"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "stock_movement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_movement" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "stock_movement"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── El libro de movimientos es inmutable ─────────────
-- Los borrados en cascada (p. ej. al eliminar una empresa) llegan desde un trigger de integridad
-- referencial: pg_trigger_depth() > 1.
CREATE FUNCTION stock_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'Los movimientos de inventario no se pueden modificar ni eliminar; registra un ajuste';
END $$;

CREATE TRIGGER stock_movement_guard BEFORE UPDATE OR DELETE ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_guard();

-- ───────────── Claves foráneas diferibles (ver migración fk_deferrable) ─────────────
ALTER TABLE "stock_level" ALTER CONSTRAINT "stock_level_productId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "stock_level" ALTER CONSTRAINT "stock_level_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "stock_movement" ALTER CONSTRAINT "stock_movement_productId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "stock_movement" ALTER CONSTRAINT "stock_movement_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "stock_movement" ALTER CONSTRAINT "stock_movement_documentId_fkey" DEFERRABLE INITIALLY DEFERRED;
