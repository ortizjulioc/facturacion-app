-- 607: retenciones que el comprador nos hizo al pagar (ITBIS, ISR y la fecha). 606: ITBIS llevado al costo y sujeto a
-- proporcionalidad. Son datos que se conocen después de emitir o registrar el comprobante.
ALTER TABLE "document" ADD COLUMN     "itbisWithheldByThirds" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "isrWithheldByThirds" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingDate" DATE;

ALTER TABLE "purchase" ADD COLUMN     "itbisToCost" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "itbisProportional" BIGINT NOT NULL DEFAULT 0;

-- Un comprobante emitido sigue congelado: solo avanzan el estado fiscal y la firma, y ahora también las retenciones
-- recibidas (que llegan cuando el cliente paga).
CREATE OR REPLACE FUNCTION document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Un comprobante emitido no se puede eliminar';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'Un comprobante emitido no puede volver a borrador';
    END IF;
    IF OLD."signedAt" IS NOT NULL AND (
      NEW."ecfXml" IS DISTINCT FROM OLD."ecfXml"
      OR NEW."securityCode" IS DISTINCT FROM OLD."securityCode"
      OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt"
    ) THEN
      RAISE EXCEPTION 'La firma de un comprobante no se puede modificar';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'updatedAt', 'ecfXml', 'securityCode', 'signedAt', 'itbisWithheldByThirds', 'isrWithheldByThirds', 'withholdingDate'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updatedAt', 'ecfXml', 'securityCode', 'signedAt', 'itbisWithheldByThirds', 'isrWithheldByThirds', 'withholdingDate']) THEN
      RAISE EXCEPTION 'Un comprobante emitido no se puede modificar';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Compra registrada: además de la fecha de pago y el tipo de retención en ISR, el ITBIS al costo y por proporcionalidad.
CREATE OR REPLACE FUNCTION purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Una compra registrada no se puede eliminar';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF (to_jsonb(NEW) - ARRAY['paymentDate', 'isrWithholdingType', 'itbisToCost', 'itbisProportional', 'updatedAt'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['paymentDate', 'isrWithholdingType', 'itbisToCost', 'itbisProportional', 'updatedAt']) THEN
      RAISE EXCEPTION 'Una compra registrada no se puede modificar';
    END IF;
  END IF;
  RETURN NEW;
END $$;
