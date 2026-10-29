-- =====================================================================
-- 025 · Código de barras y reportes de los usuarios.
--   - productos.codigo_barras: lo que lee el escáner (cámara del celular o
--     lector USB/Bluetooth, que escribe como un teclado). Único por empresa.
--   - reportes: "algo no funciona" o "me falta esto", escrito desde el panel.
--     Le llega al administrador de la plataforma; queda hasta marcarlo atendido.
-- =====================================================================
ALTER TABLE productos ADD COLUMN codigo_barras text CHECK (codigo_barras ~ '^[A-Za-z0-9._-]{3,40}$');
CREATE UNIQUE INDEX productos_codigo_barras ON productos (empresa_id, codigo_barras) WHERE codigo_barras IS NOT NULL;

CREATE TABLE reportes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id  uuid REFERENCES empresas(id),
  usuario_id  uuid NOT NULL REFERENCES usuarios(id),
  tipo        text NOT NULL CHECK (tipo IN ('PROBLEMA', 'SUGERENCIA')),
  mensaje     text NOT NULL CHECK (length(trim(mensaje)) BETWEEN 5 AND 2000),
  -- Pestaña en la que estaba (ayuda a entender el problema).
  pantalla    text,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  atendido_en timestamptz,
  atendido_por uuid REFERENCES usuarios(id)
);
CREATE INDEX reportes_pendientes ON reportes (creado_en) WHERE atendido_en IS NULL;
