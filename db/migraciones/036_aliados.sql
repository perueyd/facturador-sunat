-- =====================================================================
-- 036 · Aliados: personas que venden el facturador a otros negocios y
-- ganan una comisión sobre lo que esos clientes pagan.
--
--   - aliados: quién es aliado y su % de comisión (lo pone el dueño de la
--     plataforma). Desactivar no borra nada: sus clientes y su historial quedan.
--   - suscripciones.aliado_id: qué aliado trajo a cada cliente.
--   - pagos_suscripcion: cada pago guarda la comisión DEL MOMENTO (aliado, %
--     y monto). Cambiar el % después no cambia lo ya ganado.
--   - pagos_aliado: lo que se le pagó al aliado. Solo inserción.
--
-- El aliado NO es dueño de las empresas que trae: no ve sus comprobantes ni
-- sus datos, solo su estado de plan y su comisión.
-- =====================================================================

CREATE TABLE aliados (
  usuario_id    uuid PRIMARY KEY REFERENCES usuarios(id),
  comision      numeric(5,2) NOT NULL CHECK (comision >= 0 AND comision <= 100),
  activo        boolean NOT NULL DEFAULT true,
  creado_por    uuid REFERENCES usuarios(id),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE suscripciones ADD COLUMN aliado_id uuid REFERENCES aliados(usuario_id);
CREATE INDEX suscripciones_aliado ON suscripciones (aliado_id) WHERE aliado_id IS NOT NULL;

ALTER TABLE pagos_suscripcion
  ADD COLUMN aliado_id uuid REFERENCES aliados(usuario_id),
  ADD COLUMN comision_porcentaje numeric(5,2) CHECK (comision_porcentaje >= 0 AND comision_porcentaje <= 100),
  ADD COLUMN comision_monto numeric(10,2) CHECK (comision_monto >= 0),
  ADD CONSTRAINT pagos_suscripcion_comision_completa
    CHECK ((aliado_id IS NULL) = (comision_porcentaje IS NULL) AND (aliado_id IS NULL) = (comision_monto IS NULL));
CREATE INDEX pagos_suscripcion_aliado ON pagos_suscripcion (aliado_id, creado_en) WHERE aliado_id IS NOT NULL;

CREATE TABLE pagos_aliado (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aliado_id      uuid NOT NULL REFERENCES aliados(usuario_id),
  monto          numeric(10,2) NOT NULL CHECK (monto > 0),
  medio          text NOT NULL,
  referencia     text,
  registrado_por uuid NOT NULL REFERENCES usuarios(id),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pagos_aliado_aliado ON pagos_aliado (aliado_id, creado_en);
-- Un pago al aliado no se cambia ni se borra (como los pagos de los clientes).
CREATE TRIGGER pagos_aliado_solo_insercion BEFORE UPDATE OR DELETE ON pagos_aliado
  FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();
