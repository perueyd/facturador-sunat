-- =====================================================================
-- 013 · Un pedido cuyo comprobante SUNAT RECHAZÓ puede emitir otro.
-- Antes el índice de idempotencia contaba también los rechazados: el pedido
-- quedaba atado para siempre a un comprobante sin valor y "Emitir de nuevo"
-- devolvía el mismo rechazo. El rechazado se conserva (nunca se borra) con su
-- número; el nuevo toma el siguiente correlativo, sin saltos.
-- =====================================================================

DROP INDEX comprobantes_pedido_unico;
CREATE UNIQUE INDEX comprobantes_pedido_unico
  ON comprobantes (empresa_id, canal_id, pedido_externo_id)
  WHERE pedido_externo_id IS NOT NULL AND estado <> 'RECHAZADO';
