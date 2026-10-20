-- CreateEnum
CREATE TYPE "PrepStation" AS ENUM ('NONE', 'KITCHEN', 'BAR');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'SENT', 'READY', 'VOID');

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "orderId" UUID;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "prepStation" "PrepStation" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "dining_table" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT,
    "seats" INTEGER NOT NULL DEFAULT 4,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dining_table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "covers" INTEGER,
    "notes" TEXT,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'UND',
    "quantity" BIGINT NOT NULL,
    "unitPrice" BIGINT NOT NULL,
    "priceIncludesTax" BOOLEAN NOT NULL,
    "tax" "TaxCode" NOT NULL,
    "notes" TEXT,
    "station" "PrepStation" NOT NULL DEFAULT 'NONE',
    "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "billedQuantity" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dining_table_organizationId_branchId_idx" ON "dining_table"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "dining_table_branchId_name_key" ON "dining_table"("branchId", "name");

-- CreateIndex
CREATE INDEX "restaurant_order_organizationId_status_idx" ON "restaurant_order"("organizationId", "status");

-- CreateIndex
CREATE INDEX "restaurant_order_tableId_idx" ON "restaurant_order"("tableId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_order_organizationId_number_key" ON "restaurant_order"("organizationId", "number");

-- CreateIndex
CREATE INDEX "order_item_orderId_idx" ON "order_item"("orderId");

-- CreateIndex
CREATE INDEX "order_item_organizationId_status_station_idx" ON "order_item"("organizationId", "status", "station");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_order"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_table" ADD CONSTRAINT "dining_table_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_table" ADD CONSTRAINT "dining_table_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "dining_table"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ───────────── Restricciones ─────────────
ALTER TABLE "dining_table" ADD CONSTRAINT "dining_table_seats_chk" CHECK ("seats" BETWEEN 1 AND 50);

ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_number_chk" CHECK ("number" > 0);
ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_covers_chk" CHECK ("covers" IS NULL OR "covers" > 0);
-- Una comanda abierta no tiene fecha de cierre; una cerrada o cancelada sí.
ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_closed_chk" CHECK (("status" = 'OPEN') = ("closedAt" IS NULL));
ALTER TABLE "restaurant_order" ADD CONSTRAINT "restaurant_order_cancel_chk" CHECK ("status" <> 'CANCELLED' OR "cancelReason" IS NOT NULL);
-- Una mesa tiene a lo sumo UNA comanda abierta, aunque dos meseros la abran a la vez.
CREATE UNIQUE INDEX "restaurant_order_one_open_per_table" ON "restaurant_order" ("tableId") WHERE "status" = 'OPEN';

ALTER TABLE "order_item" ADD CONSTRAINT "order_item_amounts_chk" CHECK ("quantity" > 0 AND "unitPrice" >= 0);
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_billed_chk" CHECK ("billedQuantity" >= 0 AND "billedQuantity" <= "quantity");
-- Anular un producto ya anotado exige decir por qué.
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_void_chk" CHECK ("status" <> 'VOID' OR "voidReason" IS NOT NULL);

-- ───────────── Row-Level Security ─────────────
ALTER TABLE "dining_table" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dining_table" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dining_table"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "restaurant_order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "restaurant_order"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "order_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "order_item"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── Una comanda cerrada o cancelada queda congelada ─────────────
-- (Los borrados en cascada, p. ej. al eliminar una empresa, llegan con pg_trigger_depth() > 1.)
CREATE FUNCTION restaurant_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Una comanda no se puede eliminar; cancélala indicando el motivo';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'Una comanda cerrada o cancelada no se puede modificar';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER restaurant_order_guard BEFORE UPDATE OR DELETE ON "restaurant_order"
  FOR EACH ROW EXECUTE FUNCTION restaurant_order_guard();

CREATE FUNCTION order_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status "OrderStatus";
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "status" INTO parent_status FROM "restaurant_order"
    WHERE "id" = COALESCE(NEW."orderId", OLD."orderId");
  IF parent_status IS NOT NULL AND parent_status <> 'OPEN' THEN
    RAISE EXCEPTION 'No se puede modificar una comanda cerrada o cancelada';
  END IF;
  -- Un producto anulado no vuelve a la vida.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'VOID' AND NEW."status" <> 'VOID' THEN
    RAISE EXCEPTION 'Un producto anulado no se puede reactivar';
  END IF;
  -- Lo ya cobrado no se puede quitar ni reducir.
  IF TG_OP = 'DELETE' AND OLD."billedQuantity" > 0 THEN
    RAISE EXCEPTION 'No se puede eliminar un producto que ya se cobró';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER order_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "order_item"
  FOR EACH ROW EXECUTE FUNCTION order_item_guard();

-- ───────────── Claves foráneas diferibles (ver migración fk_deferrable) ─────────────
ALTER TABLE "dining_table" ALTER CONSTRAINT "dining_table_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order" ALTER CONSTRAINT "restaurant_order_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order" ALTER CONSTRAINT "restaurant_order_tableId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "order_item" ALTER CONSTRAINT "order_item_productId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document" ALTER CONSTRAINT "document_orderId_fkey" DEFERRABLE INITIALLY DEFERRED;
