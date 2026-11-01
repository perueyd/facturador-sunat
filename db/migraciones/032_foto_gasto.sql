-- =====================================================================
-- 032 · Foto del recibo de un gasto (sustento para el contador).
-- La imagen va al almacén y se registra en "archivos" (se conserva al menos
-- 5 años, como todo sustento). Un gasto lleva a lo más una foto: no se cambia.
-- =====================================================================
ALTER TABLE gastos ADD COLUMN foto_archivo_id uuid REFERENCES archivos(id);
