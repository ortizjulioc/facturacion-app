-- AlterTable
ALTER TABLE "cash_shift" ADD COLUMN     "clientId" UUID;

-- AlterTable
ALTER TABLE "company_profile" ADD COLUMN     "requireShift" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "returnsStock" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "cashier_pin" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cashier_pin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cashier_pin_organizationId_userId_key" ON "cashier_pin"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "cash_shift_organizationId_clientId_key" ON "cash_shift"("organizationId", "clientId");

-- AddForeignKey
ALTER TABLE "cashier_pin" ADD CONSTRAINT "cashier_pin_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ───────────── Row-Level Security ─────────────
ALTER TABLE "cashier_pin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cashier_pin" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cashier_pin"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- Un turno cerrado se congela, pero la identificación de la caja que lo abrió offline no cambia.
