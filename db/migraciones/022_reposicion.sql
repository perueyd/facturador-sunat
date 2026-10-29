-- =====================================================================
-- 022 · Reposición: cuándo y cuánto pedir a cada proveedor.
--   - proveedores.dias_entrega: días que tarda en llegar un pedido (tiempo de entrega).
--   - productos.proveedor_id: a quién se le compra normalmente ese producto.
--   - productos.dias_entrega: si ese producto tarda distinto que el resto del proveedor.
-- El "colchón" (stock de seguridad) es productos.stock_minimo, que ya existía.
-- =====================================================================
ALTER TABLE proveedores ADD COLUMN dias_entrega integer CHECK (dias_entrega BETWEEN 0 AND 365);
ALTER TABLE productos ADD COLUMN proveedor_id uuid;
ALTER TABLE productos ADD CONSTRAINT productos_proveedor_fk FOREIGN KEY (empresa_id, proveedor_id) REFERENCES proveedores (empresa_id, id);
ALTER TABLE productos ADD COLUMN dias_entrega integer CHECK (dias_entrega BETWEEN 0 AND 365);
