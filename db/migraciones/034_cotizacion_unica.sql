-- =====================================================================
-- 034 · Una boleta o factura se enlaza con UNA sola cotización.
-- Sin esto, dos cotizaciones podían quedar "convertidas" en el mismo
-- comprobante y la venta parecía cerrar dos presupuestos.
-- =====================================================================
CREATE UNIQUE INDEX cotizaciones_comprobante ON cotizaciones (comprobante_id) WHERE comprobante_id IS NOT NULL;
