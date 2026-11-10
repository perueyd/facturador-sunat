-- =====================================================================
-- 047 · Índices para lo que el panel pide cada vez que se abre.
-- Medido el 09/11/2026 con una empresa de 60.000 comprobantes:
--   · "Últimos comprobantes" ordenaba TODOS los de la empresa para mostrar 30.
--   · "Por cobrar" (Inicio, Cobrar y el resumen del día) recorría todos para
--     quedarse con los pocos que aún se deben.
-- =====================================================================
CREATE INDEX IF NOT EXISTS comprobantes_recientes ON comprobantes (empresa_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS comprobantes_por_cobrar ON comprobantes (empresa_id)
  WHERE estado_pago <> 'PAGADO' AND tipo_comprobante IN ('01', '03');
