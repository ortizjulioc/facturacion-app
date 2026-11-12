-- Fecha límite de pago de una venta a crédito (FechaLimitePago del e-CF, obligatoria con TipoPago 2).
-- Se fija en el borrador; al emitir queda congelada por document_guard como el resto del comprobante.
ALTER TABLE "document" ADD COLUMN "paymentDueDate" DATE;
