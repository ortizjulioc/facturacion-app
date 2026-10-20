-- AlterTable
ALTER TABLE "order_item" ADD COLUMN     "course" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "modifiers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "parentItemId" UUID;

-- AlterTable
ALTER TABLE "product" ADD COLUMN     "course" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "isCombo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "modifier_group" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" BIGINT NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_modifier_group" (
    "organizationId" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_modifier_group_pkey" PRIMARY KEY ("productId","groupId")
);

-- CreateTable
CREATE TABLE "combo_component" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "comboId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "combo_component_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "modifier_group_organizationId_name_key" ON "modifier_group"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_groupId_name_key" ON "modifier"("groupId", "name");

-- CreateIndex
CREATE INDEX "product_modifier_group_organizationId_idx" ON "product_modifier_group"("organizationId");

-- CreateIndex
CREATE INDEX "combo_component_organizationId_idx" ON "combo_component"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "combo_component_comboId_productId_key" ON "combo_component"("comboId", "productId");

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "order_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_group" ADD CONSTRAINT "modifier_group_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier" ADD CONSTRAINT "modifier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier" ADD CONSTRAINT "modifier_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "modifier_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_modifier_group" ADD CONSTRAINT "product_modifier_group_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_modifier_group" ADD CONSTRAINT "product_modifier_group_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "modifier_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_component" ADD CONSTRAINT "combo_component_comboId_fkey" FOREIGN KEY ("comboId") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "combo_component" ADD CONSTRAINT "combo_component_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ───────────── Restricciones ─────────────
ALTER TABLE "product" ADD CONSTRAINT "product_course_chk" CHECK ("course" BETWEEN 1 AND 5);
-- Un combo no lleva inventario propio: se descuentan sus componentes al cobrar.
ALTER TABLE "product" ADD CONSTRAINT "product_combo_chk" CHECK (NOT "isCombo" OR NOT "trackInventory");
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_course_chk" CHECK ("course" BETWEEN 1 AND 5);
ALTER TABLE "modifier_group" ADD CONSTRAINT "modifier_group_select_chk" CHECK ("minSelect" >= 0 AND "maxSelect" >= 1 AND "maxSelect" >= "minSelect");
ALTER TABLE "modifier" ADD CONSTRAINT "modifier_price_chk" CHECK ("price" >= 0);
ALTER TABLE "combo_component" ADD CONSTRAINT "combo_component_qty_chk" CHECK ("quantity" BETWEEN 1 AND 999 AND "comboId" <> "productId");

-- ───────────── Row-Level Security ─────────────
ALTER TABLE "modifier_group" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "modifier_group" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "modifier_group"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "modifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "modifier" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "modifier"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "product_modifier_group" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_modifier_group" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product_modifier_group"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "combo_component" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combo_component" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "combo_component"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── Claves foráneas diferibles (ver migración fk_deferrable) ─────────────
ALTER TABLE "combo_component" ALTER CONSTRAINT "combo_component_productId_fkey" DEFERRABLE INITIALLY DEFERRED;
