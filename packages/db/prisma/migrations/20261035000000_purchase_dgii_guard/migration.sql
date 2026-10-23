-- Una compra registrada sigue congelada, salvo dos datos del formato 606 que no cambian la contabilidad: la fecha de
-- pago (p. ej. cuando por fin se paga una compra a crédito) y el tipo de retención en ISR.
CREATE OR REPLACE FUNCTION purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Una compra registrada no se puede eliminar';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF (to_jsonb(NEW) - 'paymentDate' - 'isrWithholdingType' - 'updatedAt')
       IS DISTINCT FROM (to_jsonb(OLD) - 'paymentDate' - 'isrWithholdingType' - 'updatedAt') THEN
      RAISE EXCEPTION 'Una compra registrada no se puede modificar';
    END IF;
  END IF;
  RETURN NEW;
END $$;
