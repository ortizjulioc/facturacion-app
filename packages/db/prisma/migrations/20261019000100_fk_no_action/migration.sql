-- DropForeignKey
ALTER TABLE "document" DROP CONSTRAINT "document_branchId_fkey";

-- DropForeignKey
ALTER TABLE "document" DROP CONSTRAINT "document_customerId_fkey";

-- DropForeignKey
ALTER TABLE "document" DROP CONSTRAINT "document_referencedDocumentId_fkey";

-- DropForeignKey
ALTER TABLE "document" DROP CONSTRAINT "document_terminalId_fkey";

-- DropForeignKey
ALTER TABLE "document_line" DROP CONSTRAINT "document_line_productId_fkey";

-- DropForeignKey
ALTER TABLE "sequence" DROP CONSTRAINT "sequence_terminalId_fkey";

-- DropForeignKey
ALTER TABLE "terminal" DROP CONSTRAINT "terminal_branchId_fkey";

-- AddForeignKey
ALTER TABLE "terminal" ADD CONSTRAINT "terminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence" ADD CONSTRAINT "sequence_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branch"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "terminal"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_referencedDocumentId_fkey" FOREIGN KEY ("referencedDocumentId") REFERENCES "document"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_line" ADD CONSTRAINT "document_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

