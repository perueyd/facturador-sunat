-- =====================================================================
-- 039 · Comprobantes antiguos (OPCIONAL): los emitidos ANTES de este facturador
-- (SUNAT Operaciones en Línea, app Emprende, otro sistema). El dueño sube los XML
-- que descargó de SUNAT y los consulta junto con los nuevos.
--
--   - Es solo un HISTORIAL de consulta: no se envían a SUNAT, no cuentan en ventas,
--     impuestos, caja ni correlativos (por eso van en una tabla aparte).
--   - Solo inserción: un comprobante subido no se cambia ni se borra.
--   - Viene APAGADO: cada empresa lo prende desde el panel si lo quiere usar.
-- =====================================================================

CREATE TABLE comprobantes_antiguos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES empresas(id),
  tipo            char(2) NOT NULL CHECK (tipo IN ('01', '03', '07', '08')),
  serie           varchar(4) NOT NULL CHECK (serie ~ '^[A-Z0-9]{4}$'),
  numero          integer NOT NULL CHECK (numero > 0),
  fecha_emision   date NOT NULL,
  cliente_tipo_doc text,
  cliente_doc     text,
  cliente_nombre  text,
  moneda          char(3) NOT NULL,
  total           numeric(14,2) NOT NULL CHECK (total >= 0),
  igv             numeric(14,2),
  -- La firma del XML se comprueba al subirlo: dice si el archivo está intacto.
  firma_valida    boolean NOT NULL,
  archivo_id      uuid NOT NULL REFERENCES archivos(id),
  subido_por      uuid REFERENCES usuarios(id),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, tipo, serie, numero)
);
CREATE INDEX comprobantes_antiguos_fecha ON comprobantes_antiguos (empresa_id, fecha_emision DESC);
CREATE TRIGGER comprobantes_antiguos_solo_insercion BEFORE UPDATE OR DELETE ON comprobantes_antiguos
  FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();

-- Función nueva del panel, apagada para todas las empresas (las actuales y las nuevas).
ALTER TABLE empresas DROP CONSTRAINT empresas_modulos_desactivados_check;
ALTER TABLE empresas ADD CONSTRAINT empresas_modulos_desactivados_check
  CHECK (modulos_desactivados <@ ARRAY['panel', 'vencimientos', 'resumen', 'certificado', 'cobros', 'notas', 'productos', 'exportar', 'compras', 'avisos', 'estadisticas', 'antiguos']);
UPDATE empresas SET modulos_desactivados = array_append(modulos_desactivados, 'antiguos')
 WHERE NOT ('antiguos' = ANY(modulos_desactivados));
ALTER TABLE empresas ALTER COLUMN modulos_desactivados SET DEFAULT '{antiguos}';
