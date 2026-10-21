-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "shiftId" UUID;

-- CreateTable
CREATE TABLE "cash_shift" (
    "id" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "terminalId" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingAmount" BIGINT NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "countedCash" BIGINT,
    "expectedCash" BIGINT,
    "difference" BIGINT,
    "notes" TEXT,
    "closingReport" JSONB,

    CONSTRAINT "cash_shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_shift_organizationId_openedAt_idx" ON "cash_shift"("organizationId", "openedAt");

-- CreateIndex
CREATE INDEX "cash_shift_terminalId_status_idx" ON "cash_shift"("terminalId", "status");

-- CreateIndex
CREATE INDEX "document_shiftId_idx" ON "document"("shiftId");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cash_shift"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ───────────── Restricciones ─────────────
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_opening_chk" CHECK ("openingAmount" >= 0);
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_counted_chk" CHECK ("countedCash" IS NULL OR "countedCash" >= 0);
-- Abierto = sin datos de cierre; cerrado = con quién, cuándo y el cuadre completo.
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_closed_chk" CHECK (
  ("status" = 'OPEN' AND "closedAt" IS NULL AND "closedById" IS NULL AND "countedCash" IS NULL)
  OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL
      AND "countedCash" IS NOT NULL AND "expectedCash" IS NOT NULL AND "difference" IS NOT NULL
      AND "difference" = "countedCash" - "expectedCash")
);
-- Una caja tiene a lo sumo UN turno abierto, aunque dos personas intenten abrirlo a la vez.
CREATE UNIQUE INDEX "cash_shift_one_open_per_terminal" ON "cash_shift" ("terminalId") WHERE "status" = 'OPEN';

-- ───────────── Row-Level Security ─────────────
ALTER TABLE "cash_shift" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_shift" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_shift"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── Un turno cerrado queda congelado ─────────────
-- (Los borrados en cascada, p. ej. al eliminar una empresa, llegan con pg_trigger_depth() > 1.)
CREATE FUNCTION cash_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Un turno de caja no se puede eliminar';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'Un turno cerrado no se puede modificar';
  END IF;
  -- Al abrirse, estos datos ya no cambian.
  IF NEW."terminalId" <> OLD."terminalId" OR NEW."openedById" <> OLD."openedById"
     OR NEW."openedAt" <> OLD."openedAt" OR NEW."openingAmount" <> OLD."openingAmount" THEN
    RAISE EXCEPTION 'Los datos de apertura del turno no se pueden modificar';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cash_shift_guard BEFORE UPDATE OR DELETE ON "cash_shift"
  FOR EACH ROW EXECUTE FUNCTION cash_shift_guard();

-- ───────────── Claves foráneas diferibles (ver migración fk_deferrable) ─────────────
ALTER TABLE "cash_shift" ALTER CONSTRAINT "cash_shift_terminalId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document" ALTER CONSTRAINT "document_shiftId_fkey" DEFERRABLE INITIALLY DEFERRED;
