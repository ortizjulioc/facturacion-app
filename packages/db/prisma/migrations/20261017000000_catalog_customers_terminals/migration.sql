-- CreateEnum
CREATE TYPE "TaxCode" AS ENUM ('ITBIS18', 'ITBIS16', 'ITBIS0', 'EXENTO');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('RNC', 'CEDULA', 'PASAPORTE');

-- CreateTable
CREATE TABLE "terminal" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "categoryId" UUID,
    "sku" TEXT,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" BIGINT NOT NULL,
    "priceIncludesTax" BOOLEAN NOT NULL DEFAULT true,
    "tax" "TaxCode" NOT NULL DEFAULT 'ITBIS18',
    "unit" TEXT NOT NULL DEFAULT 'UND',
    "allowsDecimals" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
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

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "terminal_branchId_idx" ON "terminal"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_organizationId_code_key" ON "terminal"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "category_organizationId_name_key" ON "category"("organizationId", "name");

-- CreateIndex
CREATE INDEX "product_organizationId_name_idx" ON "product"("organizationId", "name");

-- CreateIndex
CREATE INDEX "product_categoryId_idx" ON "product"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "product_organizationId_sku_key" ON "product"("organizationId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_organizationId_barcode_key" ON "product"("organizationId", "barcode");

-- CreateIndex
CREATE INDEX "customer_organizationId_name_idx" ON "customer"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_organizationId_documentNumber_key" ON "customer"("organizationId", "documentNumber");

-- AddForeignKey
ALTER TABLE "terminal" ADD CONSTRAINT "terminal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal" ADD CONSTRAINT "terminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Row-Level Security (mismo patrón que branch) ─────────────
ALTER TABLE "terminal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "terminal" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "terminal"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "category" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "category" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "category"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "product"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

ALTER TABLE "customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customer"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));
