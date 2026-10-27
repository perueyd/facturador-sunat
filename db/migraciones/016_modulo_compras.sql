-- =====================================================================
-- 016 · Función "compras" del panel (registrar facturas de proveedores).
-- =====================================================================
ALTER TABLE empresas DROP CONSTRAINT empresas_modulos_desactivados_check;
ALTER TABLE empresas ADD CONSTRAINT empresas_modulos_desactivados_check
  CHECK (modulos_desactivados <@ ARRAY['panel', 'vencimientos', 'resumen', 'certificado', 'cobros', 'notas', 'productos', 'exportar', 'compras']);
