-- =====================================================================
-- 024 · Cuentas donde se recibe el dinero (caja).
-- Un negocio pequeño cobra en varios lugares: el Yape de la empresa, el Yape
-- de una persona, efectivo, una cuenta del banco… Cada cobro dice a qué cuenta
-- entró, para cuadrar la caja por cuenta y en total.
-- La venta es de la empresa igual (lleva su boleta o factura); esto solo
-- registra DÓNDE quedó el dinero.
-- =====================================================================
CREATE TABLE cuentas_cobro (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  nombre         text NOT NULL CHECK (length(trim(nombre)) BETWEEN 1 AND 60),
  medio          medio_pago NOT NULL,
  -- De quién es la cuenta (la empresa, "Juan Pérez"…).
  titular        text,
  de_la_empresa  boolean NOT NULL DEFAULT true,
  -- La que se usa cuando el cobro no dice cuenta (ej. los pagos de la tienda web).
  predeterminada boolean NOT NULL DEFAULT false,
  activa         boolean NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);
CREATE UNIQUE INDEX cuentas_cobro_nombre ON cuentas_cobro (empresa_id, lower(nombre));
CREATE UNIQUE INDEX cuentas_cobro_predeterminada ON cuentas_cobro (empresa_id, medio) WHERE predeterminada AND activa;

ALTER TABLE pagos ADD COLUMN cuenta_id uuid;
ALTER TABLE pagos ADD CONSTRAINT pagos_cuenta_fk FOREIGN KEY (empresa_id, cuenta_id) REFERENCES cuentas_cobro (empresa_id, id);
CREATE INDEX pagos_cuenta ON pagos (cuenta_id);

-- La cuenta de un pago tampoco cambia después: si se eligió mal, se anula y se registra de nuevo.
CREATE OR REPLACE FUNCTION pagos_solo_anular() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.empresa_id, NEW.comprobante_id, NEW.fecha, NEW.monto, NEW.medio, NEW.referencia_operacion, NEW.creado_en, NEW.cuenta_id)
     IS DISTINCT FROM (OLD.empresa_id, OLD.comprobante_id, OLD.fecha, OLD.monto, OLD.medio, OLD.referencia_operacion, OLD.creado_en, OLD.cuenta_id)
     OR OLD.anulado_en IS NOT NULL THEN
    RAISE EXCEPTION 'Un pago registrado no se modifica; anúlalo con un motivo y registra el correcto.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
