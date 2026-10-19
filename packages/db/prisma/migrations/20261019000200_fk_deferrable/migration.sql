-- Las claves foráneas que protegen comprobantes y rangos se verifican al CONFIRMAR la transacción,
-- no fila por fila. Así, eliminar una empresa (que borra en cascada productos, líneas, documentos…)
-- no depende del orden en que Postgres ejecute las cascadas, y borrar un producto que está en uso
-- sigue fallando al confirmar.
ALTER TABLE "terminal" ALTER CONSTRAINT "terminal_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "sequence" ALTER CONSTRAINT "sequence_terminalId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document" ALTER CONSTRAINT "document_branchId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document" ALTER CONSTRAINT "document_terminalId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document" ALTER CONSTRAINT "document_customerId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document" ALTER CONSTRAINT "document_referencedDocumentId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "document_line" ALTER CONSTRAINT "document_line_productId_fkey" DEFERRABLE INITIALLY DEFERRED;
