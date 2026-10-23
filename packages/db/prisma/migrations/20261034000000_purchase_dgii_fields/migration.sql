-- 606: fecha de pago y tipo de retención en ISR de la compra.
ALTER TABLE "purchase" ADD COLUMN     "isrWithholdingType" INTEGER,
ADD COLUMN     "paymentDate" DATE;
