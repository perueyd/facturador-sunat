-- =====================================================================
-- 027 · Cierre de caja diario.
-- Al terminar el día se cuenta lo que hay en cada cuenta (el efectivo del
-- cajón, el Yape…) y se compara con lo que dicen los cobros registrados.
-- La diferencia queda guardada con quién cerró y cuándo.
-- Un cierre no se cambia ni se borra: si se contó mal, se cierra otra vez el
-- mismo día y vale el último (los anteriores quedan como historial).
-- =====================================================================
CREATE TABLE cierres_caja (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id),
  fecha       date NOT NULL,
  usuario_id  uuid NOT NULL REFERENCES usuarios(id),
  nota        text CHECK (length(nota) <= 300),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cierres_caja_fecha ON cierres_caja (empresa_id, fecha, creado_en DESC);
CREATE TRIGGER cierres_caja_solo_insercion BEFORE UPDATE OR DELETE ON cierres_caja FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();

CREATE TABLE cierre_caja_lineas (
  cierre_id  uuid NOT NULL REFERENCES cierres_caja(id),
  linea      int NOT NULL,
  -- NULL: cobros de ese medio que no dijeron cuenta ("Sin cuenta: Efectivo").
  cuenta_id  uuid REFERENCES cuentas_cobro(id),
  medio      medio_pago NOT NULL,
  nombre     text NOT NULL,
  esperado   numeric(14,2) NOT NULL,
  contado    numeric(14,2) NOT NULL CHECK (contado >= 0),
  PRIMARY KEY (cierre_id, linea)
);
CREATE TRIGGER cierre_caja_lineas_solo_insercion BEFORE UPDATE OR DELETE ON cierre_caja_lineas FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();
