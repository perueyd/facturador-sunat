-- =====================================================================
-- 029 · Gastos y caja chica.
-- El dinero que SALE: pasajes, materiales, luz, pago a un ayudante…
-- Cada gasto dice de qué cuenta salió (el cajón de efectivo, el Yape…), así
-- el cierre de caja compara lo contado con cobros MENOS gastos.
-- Las compras de mercadería con factura (para el IGV y el stock) siguen
-- registrándose en Compras; esto es el control del dinero.
-- No se borra: se anula con motivo, guardando quién y cuándo.
-- =====================================================================
CREATE TABLE gastos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  fecha          date NOT NULL,
  monto          numeric(14,2) NOT NULL CHECK (monto > 0),
  categoria      text NOT NULL CHECK (categoria IN ('MERCADERIA', 'INSUMOS', 'ALQUILER', 'SERVICIOS', 'SUELDOS', 'TRANSPORTE',
                                                   'MANTENIMIENTO', 'PUBLICIDAD', 'IMPUESTOS', 'OTROS')),
  descripcion    text NOT NULL CHECK (length(trim(descripcion)) BETWEEN 1 AND 200),
  medio          medio_pago NOT NULL,
  cuenta_id      uuid,
  -- Comprobante que dio el proveedor (opcional): "F001-123", "recibo", etc.
  documento      text CHECK (length(documento) <= 60),
  registrado_por uuid NOT NULL REFERENCES usuarios(id),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  anulado_en     timestamptz,
  anulado_por    uuid REFERENCES usuarios(id),
  motivo_anulacion text,
  FOREIGN KEY (empresa_id, cuenta_id) REFERENCES cuentas_cobro (empresa_id, id),
  CHECK ((anulado_en IS NULL) = (motivo_anulacion IS NULL))
);
CREATE INDEX gastos_fecha ON gastos (empresa_id, fecha);

-- Un gasto registrado no se cambia: si estaba mal, se anula con motivo y se registra el correcto.
CREATE FUNCTION gastos_solo_anular() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un gasto no se borra: se anula con un motivo.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.empresa_id, NEW.fecha, NEW.monto, NEW.categoria, NEW.descripcion, NEW.medio, NEW.cuenta_id, NEW.documento, NEW.registrado_por, NEW.creado_en)
     IS DISTINCT FROM (OLD.empresa_id, OLD.fecha, OLD.monto, OLD.categoria, OLD.descripcion, OLD.medio, OLD.cuenta_id, OLD.documento, OLD.registrado_por, OLD.creado_en)
     OR OLD.anulado_en IS NOT NULL THEN
    RAISE EXCEPTION 'Un gasto registrado no se modifica; anúlalo con un motivo y registra el correcto.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gastos_fijos BEFORE UPDATE OR DELETE ON gastos FOR EACH ROW EXECUTE FUNCTION gastos_solo_anular();
