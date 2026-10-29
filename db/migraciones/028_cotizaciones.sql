-- =====================================================================
-- 028 · Cotizaciones (proformas).
-- Un presupuesto para el cliente ANTES de vender. No es comprobante de pago:
-- no va a SUNAT ni cuenta como venta. Cuando el cliente acepta y paga, se
-- emite la boleta o factura y la cotización queda enlazada a ella.
-- Numeración propia por empresa (COT-000001), sin relación con las series.
-- No se borra: se anula guardando quién y cuándo.
-- =====================================================================
CREATE TABLE cotizaciones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES empresas(id),
  numero            integer NOT NULL CHECK (numero > 0),
  fecha             date NOT NULL,
  valida_hasta      date NOT NULL CHECK (valida_hasta >= fecha),
  cliente_documento text NOT NULL DEFAULT 'NINGUNO' CHECK (cliente_documento IN ('DNI', 'RUC', 'CE', 'PASAPORTE', 'NINGUNO')),
  cliente_numero    text NOT NULL DEFAULT '',
  cliente_nombre    text NOT NULL DEFAULT '' CHECK (length(cliente_nombre) <= 200),
  nota              text CHECK (length(nota) <= 500),
  total             numeric(14,2) NOT NULL CHECK (total >= 0),
  estado            text NOT NULL DEFAULT 'VIGENTE' CHECK (estado IN ('VIGENTE', 'CONVERTIDA', 'ANULADA')),
  comprobante_id    uuid REFERENCES comprobantes(id),
  usuario_id        uuid NOT NULL REFERENCES usuarios(id),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  cambiado_por      uuid REFERENCES usuarios(id),
  cambiado_en       timestamptz,
  UNIQUE (empresa_id, numero),
  CHECK ((estado = 'CONVERTIDA') = (comprobante_id IS NOT NULL))
);
CREATE INDEX cotizaciones_recientes ON cotizaciones (empresa_id, creado_en DESC);

CREATE TABLE cotizacion_items (
  cotizacion_id uuid NOT NULL REFERENCES cotizaciones(id),
  orden         integer NOT NULL CHECK (orden > 0),
  codigo        text,
  descripcion   text NOT NULL CHECK (length(trim(descripcion)) BETWEEN 1 AND 250),
  cantidad      numeric(22,10) NOT NULL CHECK (cantidad > 0),
  precio        numeric(22,10) NOT NULL CHECK (precio >= 0),
  importe       numeric(14,2) NOT NULL,
  PRIMARY KEY (cotizacion_id, orden)
);
CREATE TRIGGER cotizacion_items_solo_insercion BEFORE UPDATE OR DELETE ON cotizacion_items FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();

-- De una cotización solo cambia el estado (una vez): lo cotizado queda como se envió al cliente.
CREATE FUNCTION cotizaciones_solo_estado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una cotización no se borra: se anula.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.empresa_id, NEW.numero, NEW.fecha, NEW.valida_hasta, NEW.cliente_documento, NEW.cliente_numero, NEW.cliente_nombre, NEW.nota, NEW.total, NEW.usuario_id, NEW.creado_en)
     IS DISTINCT FROM (OLD.empresa_id, OLD.numero, OLD.fecha, OLD.valida_hasta, OLD.cliente_documento, OLD.cliente_numero, OLD.cliente_nombre, OLD.nota, OLD.total, OLD.usuario_id, OLD.creado_en)
     OR OLD.estado <> 'VIGENTE' THEN
    RAISE EXCEPTION 'Una cotización enviada no se modifica; anúlala y haz otra.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cotizaciones_fijas BEFORE UPDATE OR DELETE ON cotizaciones FOR EACH ROW EXECUTE FUNCTION cotizaciones_solo_estado();
