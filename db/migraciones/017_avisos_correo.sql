-- =====================================================================
-- 017 · Avisos por correo: vencimiento de la declaración, certificado por
-- vencer y alertas rojas (comprobante rechazado). Cada aviso se envía UNA vez:
-- la clave única impide repetirlo aunque el cron corra cada 5 minutos.
-- =====================================================================
CREATE TABLE avisos_enviados (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id  uuid NOT NULL REFERENCES empresas(id),
  tipo        text NOT NULL,
  clave       text NOT NULL,
  destinos    text[] NOT NULL,
  enviado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, tipo, clave)
);

ALTER TABLE empresas DROP CONSTRAINT empresas_modulos_desactivados_check;
ALTER TABLE empresas ADD CONSTRAINT empresas_modulos_desactivados_check
  CHECK (modulos_desactivados <@ ARRAY['panel', 'vencimientos', 'resumen', 'certificado', 'cobros', 'notas', 'productos', 'exportar', 'compras', 'avisos']);
