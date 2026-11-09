-- =====================================================================
-- 045 · Categoría de cada producto (ej. "Tarimas", "Colchones"): para
-- ordenar el catálogo y buscar más rápido. Texto libre (el panel sugiere
-- las que ya existen), opcional; no cambia los comprobantes ni el stock.
-- =====================================================================
ALTER TABLE productos ADD COLUMN categoria text
  CHECK (categoria IS NULL OR (length(categoria) BETWEEN 1 AND 40 AND categoria = btrim(categoria)));
CREATE INDEX productos_categoria ON productos (empresa_id, lower(categoria)) WHERE categoria IS NOT NULL;
