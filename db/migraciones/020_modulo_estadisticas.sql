-- =====================================================================
-- 020 · Función "estadisticas" del panel: ventas de hoy y del mes, ticket
-- promedio, clientes, gráficos de 6 meses y 30 días, canales y productos.
-- Se puede desactivar por empresa como las demás.
-- =====================================================================
ALTER TABLE empresas DROP CONSTRAINT empresas_modulos_desactivados_check;
ALTER TABLE empresas ADD CONSTRAINT empresas_modulos_desactivados_check
  CHECK (modulos_desactivados <@ ARRAY['panel', 'vencimientos', 'resumen', 'certificado', 'cobros', 'notas', 'productos', 'exportar', 'compras', 'avisos', 'estadisticas']);
