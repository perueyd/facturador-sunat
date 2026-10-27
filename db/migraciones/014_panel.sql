-- =====================================================================
-- 014 · Panel web: sesiones de usuario y protección del segundo paso.
-- La tabla usuarios ya tenía contraseña, secreto TOTP cifrado, intentos
-- fallidos y bloqueo (migración 001); aquí se agrega lo que faltaba.
-- =====================================================================

-- Último paso de 30 s aceptado: un código de 6 dígitos ya usado no sirve otra vez
-- (si alguien lo ve por encima del hombro, llega tarde).
ALTER TABLE usuarios ADD COLUMN totp_ultimo_paso bigint;

-- Sesión del panel. En la base solo se guarda la huella SHA-256 del token: quien lea
-- la tabla no puede usar las sesiones. Nunca se borran; se revocan o vencen.
CREATE TABLE sesiones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  uuid NOT NULL REFERENCES usuarios(id),
  token_hash  bytea NOT NULL UNIQUE,
  empresa_id  uuid REFERENCES empresas(id),
  ip          text,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  expira_en   timestamptz NOT NULL,
  revocada_en timestamptz
);
CREATE INDEX sesiones_usuario ON sesiones (usuario_id);
