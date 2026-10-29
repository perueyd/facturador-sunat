-- =====================================================================
-- 023 · Invitaciones: el usuario nuevo recibe un ENLACE y él mismo pone su
-- contraseña y conecta su app autenticadora. Quien invita nunca conoce su clave.
-- Del enlace solo se guarda la huella SHA-256. Vale 72 horas y una sola vez.
-- =====================================================================
CREATE TABLE invitaciones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  uuid NOT NULL REFERENCES usuarios(id),
  empresa_id  uuid NOT NULL REFERENCES empresas(id),
  token_hash  bytea NOT NULL UNIQUE,
  creada_por  uuid REFERENCES usuarios(id),
  creado_en   timestamptz NOT NULL DEFAULT now(),
  expira_en   timestamptz NOT NULL,
  usada_en    timestamptz,
  -- Al generar un enlace nuevo, el anterior deja de servir.
  anulada_en  timestamptz
);
CREATE INDEX invitaciones_usuario ON invitaciones (usuario_id);
