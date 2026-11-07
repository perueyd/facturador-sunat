-- =====================================================================
-- 042 · El dinero devuelto a un cliente (reembolso de una devolución) sale de una
-- cuenta concreta, como un gasto: así la Caja y el cierre lo restan de esa cuenta
-- (antes no se restaba en ningún lado y la caja "sobraba").
-- =====================================================================
ALTER TABLE reembolsos ADD COLUMN cuenta_id uuid REFERENCES cuentas_cobro(id);
CREATE INDEX reembolsos_fecha ON reembolsos (empresa_id, fecha);
