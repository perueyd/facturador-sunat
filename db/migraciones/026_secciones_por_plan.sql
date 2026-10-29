-- =====================================================================
-- 026 · Secciones que incluye cada plan.
-- Solo se reparten por plan las secciones "extra" (cobros y caja, stock e
-- inventario, compras, estadísticas). Lo que el cliente necesita para cumplir
-- con SUNAT (emitir, notas de crédito, vencimientos, resumen de impuestos,
-- avisos, exportar para el contador) va en TODOS los planes.
-- Una empresa propia (sin suscripción) tiene todo.
-- =====================================================================
ALTER TABLE planes ADD COLUMN secciones text[] NOT NULL DEFAULT ARRAY['cobros', 'productos', 'compras', 'estadisticas']
  CHECK (secciones <@ ARRAY['cobros', 'productos', 'compras', 'estadisticas']);
UPDATE planes SET secciones = ARRAY['cobros'] WHERE codigo = 'EMPRENDEDOR';
