-- =====================================================================
-- 041 · Padrón de SUNAT (empresas, RUC 20) para completar la razón social sola
-- y avisar si un RUC no está activo o no está habido.
--
-- Fuente: "Padrón reducido del RUC" que SUNAT publica a diario (consultado el
-- 07/11/2026: https://www2.sunat.gob.pe/padron_reducido_ruc.zip, 395 MB, 18,5
-- millones de RUC). Para que entre en el plan gratis de Supabase (500 MB) se
-- guardan solo los RUC 20 que NO están de baja: ~1,05 millones, ~110 MB.
-- Si un RUC 20 no está aquí, está de baja (o no existe): el panel lo avisa.
--
-- Va en un esquema aparte ("padron"): no es información del negocio, se vuelve a
-- bajar de SUNAT cuando se quiera, así que el respaldo diario no lo copia.
-- Lo carga cada día .github/workflows/padron.yml (scripts/padron.ts).
-- =====================================================================
CREATE SCHEMA padron;

-- Estado ("ACTIVO", "SUSPENSION TEMPORAL"…) y condición ("HABIDO", "NO HABIDO"…) se
-- repiten millones de veces: se guardan una sola vez y cada RUC lleva su número.
CREATE TABLE padron.textos (
  id    smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  texto text NOT NULL UNIQUE
);

CREATE TABLE padron.ruc (
  ruc       bigint PRIMARY KEY,
  nombre    text NOT NULL,
  estado    smallint NOT NULL,
  condicion smallint NOT NULL
);

-- Cada carga diaria: cuántos RUC, cuántos cambiaron y de qué fecha es el archivo de SUNAT.
CREATE TABLE padron.cargas (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  archivo_del  timestamptz,
  filas        integer NOT NULL,
  cambios      integer NOT NULL,
  quitados     integer NOT NULL,
  cargado_en   timestamptz NOT NULL DEFAULT now()
);
