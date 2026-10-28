-- =====================================================================
-- 019 · Recuperar el acceso sin entrar a Render.
--   - Códigos de respaldo: entran en lugar del código de la app si se
--     pierde el celular. Un solo uso cada uno.
--   - Enlaces por correo: cambiar la contraseña olvidada (siguen pidiendo
--     el código de la app o uno de respaldo). Valen 30 minutos, una vez.
-- De los dos solo se guarda la huella SHA-256: quien lea la tabla no puede usarlos.
-- Nunca se borran; se usan, se anulan o vencen (quedan como historial).
-- =====================================================================

CREATE TABLE codigos_respaldo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id),
  hash       bytea NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  usado_en   timestamptz,
  -- Al generar códigos nuevos, los anteriores que no se usaron dejan de servir.
  anulado_en timestamptz
);
CREATE INDEX codigos_respaldo_vigentes ON codigos_respaldo (usuario_id) WHERE usado_en IS NULL AND anulado_en IS NULL;

CREATE TABLE recuperaciones_correo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id),
  token_hash bytea NOT NULL UNIQUE,
  ip         text,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  expira_en  timestamptz NOT NULL,
  usado_en   timestamptz
);
CREATE INDEX recuperaciones_correo_usuario ON recuperaciones_correo (usuario_id, creado_en);
