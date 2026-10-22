-- AlterTable
ALTER TABLE "received_document" ADD COLUMN     "purchaseId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "received_document_purchaseId_key" ON "received_document"("purchaseId");

-- AddForeignKey
ALTER TABLE "received_document" ADD CONSTRAINT "received_document_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

