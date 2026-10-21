-- AlterTable
ALTER TABLE "document" ADD COLUMN     "clientId" UUID;

-- AlterTable
ALTER TABLE "sequence" ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "document_organizationId_clientId_key" ON "document"("organizationId", "clientId");

