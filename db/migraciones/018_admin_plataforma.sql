-- =====================================================================
-- 018 · Administrador de la plataforma: quien vende el facturador puede dar de
-- alta empresas nuevas desde el panel. Solo se activa por comando, en la PC.
-- =====================================================================
ALTER TABLE usuarios ADD COLUMN admin_plataforma boolean NOT NULL DEFAULT false;
