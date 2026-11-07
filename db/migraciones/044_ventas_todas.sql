-- =====================================================================
-- 044 · Una sola vista con TODAS las ventas del negocio, para que todas las
-- pantallas (Estadísticas, Resultado del mes, Caja) den los mismos números:
--   - FACTURADOR:   comprobantes emitidos aquí (boletas, facturas, notas).
--   - CONTINGENCIA: boletas/facturas impresas cuando no había internet (040).
--   - SUNAT:        emitidos en SUNAT SOL/Emprende y subidos como XML (039).
-- Las notas de crédito restan (tipo 07). Los rechazados o anulados se excluyen
-- con la misma condición de siempre (estado NOT IN ('RECHAZADO', 'ANULADO')).
-- =====================================================================
CREATE VIEW ventas_todas AS
  SELECT c.empresa_id, c.id, 'FACTURADOR'::text AS origen, c.tipo_comprobante, c.fecha_emision, c.estado::text AS estado,
         c.importe_total, c.total_gravado, c.total_exonerado, c.total_inafecto, c.total_igv,
         c.cliente_numero_doc, c.canal_id, c.emitido_por_usuario, c.comprobante_referencia_id
    FROM comprobantes c
  UNION ALL
  SELECT v.empresa_id, v.id, 'CONTINGENCIA', v.tipo, v.fecha_emision, 'ACEPTADO',
         v.importe_total, v.total_gravado, v.total_exonerado, v.total_inafecto, v.total_igv,
         v.cliente_doc, v.canal_id, v.registrado_por, NULL
    FROM ventas_contingencia v
  UNION ALL
  -- Del XML solo se conoce el total y el IGV: la base es la diferencia (como gravada).
  SELECT a.empresa_id, a.id, 'SUNAT', a.tipo, a.fecha_emision, 'ACEPTADO',
         a.total, a.total - coalesce(a.igv, 0), 0, 0, coalesce(a.igv, 0),
         coalesce(a.cliente_doc, '-'), NULL, NULL, NULL
    FROM comprobantes_antiguos a WHERE a.moneda = 'PEN';
