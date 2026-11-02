-- =====================================================================
-- 035 · Índices para que dos búsquedas frecuentes no recorran toda la tabla.
-- - Notas de crédito de un comprobante: se buscan cada vez que se calcula
--   cuánto debe un cliente (saldo) y al anular. Sin índice, PostgreSQL
--   revisaba TODOS los comprobantes de TODAS las empresas.
-- - Compras de un cliente: su historial (por cliente_id) y los clientes
--   frecuentes de las estadísticas (por DNI/RUC).
-- Con pocos datos no se nota; con miles de comprobantes, sí.
-- =====================================================================
CREATE INDEX comprobantes_referencia ON comprobantes (comprobante_referencia_id) WHERE comprobante_referencia_id IS NOT NULL;
CREATE INDEX comprobantes_cliente ON comprobantes (empresa_id, cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX comprobantes_cliente_doc ON comprobantes (empresa_id, cliente_numero_doc);
