-- =====================================================================
-- 043 · "Ya declaré este mes": el dueño o el contador marcan el período como
-- declarado y el Inicio pasa al siguiente (antes seguía mostrando octubre hasta
-- su fecha de vencimiento aunque ya se hubiera declarado). Si se marcó por error
-- se desmarca; cada cambio queda en la auditoría.
-- =====================================================================
CREATE TABLE declaraciones_mensuales (
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  periodo        char(7) NOT NULL CHECK (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  registrado_por uuid REFERENCES usuarios(id),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, periodo)
);
