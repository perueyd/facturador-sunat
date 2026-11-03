-- =====================================================================
-- 037 · Mis sesiones: en qué aparatos está abierto el panel.
--   - aparato: descripción corta del navegador y del sistema ("Safari en
--     iPhone"), sacada del navegador al entrar. No se guarda el texto completo
--     que manda el navegador: solo lo necesario para reconocerlo.
--   - ultimo_uso_en: cuándo se usó por última vez (se actualiza cada 5 min
--     como máximo, para no escribir en cada clic).
-- =====================================================================
ALTER TABLE sesiones ADD COLUMN aparato text CHECK (char_length(aparato) <= 80);
ALTER TABLE sesiones ADD COLUMN ultimo_uso_en timestamptz;
