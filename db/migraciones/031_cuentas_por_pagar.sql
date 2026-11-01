-- =====================================================================
-- 031 · Cuentas por pagar a proveedores.
-- Una compra puede ser al CONTADO (como hasta ahora) o al CRÉDITO con fecha
-- de vencimiento. Cada pago al proveedor se registra aparte (en partes si
-- hace falta) y dice de qué cuenta salió el dinero, para la caja.
-- Un pago no se cambia ni se borra: se anula con motivo.
-- =====================================================================
ALTER TABLE compras ADD COLUMN condicion text NOT NULL DEFAULT 'CONTADO' CHECK (condicion IN ('CONTADO', 'CREDITO'));
ALTER TABLE compras ADD COLUMN vence date;
ALTER TABLE compras ADD CONSTRAINT compras_credito_vence CHECK ((condicion = 'CREDITO') = (vence IS NOT NULL));

CREATE TABLE pagos_compra (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  compra_id        uuid NOT NULL REFERENCES compras(id),
  fecha            date NOT NULL,
  monto            numeric(14,2) NOT NULL CHECK (monto > 0),
  medio            medio_pago NOT NULL,
  cuenta_id        uuid,
  referencia       text CHECK (length(referencia) <= 60),
  registrado_por   uuid NOT NULL REFERENCES usuarios(id),
  creado_en        timestamptz NOT NULL DEFAULT now(),
  anulado_en       timestamptz,
  anulado_por      uuid REFERENCES usuarios(id),
  motivo_anulacion text,
  FOREIGN KEY (empresa_id, cuenta_id) REFERENCES cuentas_cobro (empresa_id, id),
  CHECK ((anulado_en IS NULL) = (motivo_anulacion IS NULL))
);
CREATE INDEX pagos_compra_compra ON pagos_compra (compra_id);
CREATE INDEX pagos_compra_fecha ON pagos_compra (empresa_id, fecha);

CREATE FUNCTION pagos_compra_solo_anular() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un pago a proveedor no se borra: se anula con un motivo.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.empresa_id, NEW.compra_id, NEW.fecha, NEW.monto, NEW.medio, NEW.cuenta_id, NEW.referencia, NEW.registrado_por, NEW.creado_en)
     IS DISTINCT FROM (OLD.empresa_id, OLD.compra_id, OLD.fecha, OLD.monto, OLD.medio, OLD.cuenta_id, OLD.referencia, OLD.registrado_por, OLD.creado_en)
     OR OLD.anulado_en IS NOT NULL THEN
    RAISE EXCEPTION 'Un pago a proveedor no se modifica; anúlalo con un motivo y registra el correcto.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pagos_compra_fijos BEFORE UPDATE OR DELETE ON pagos_compra FOR EACH ROW EXECUTE FUNCTION pagos_compra_solo_anular();
