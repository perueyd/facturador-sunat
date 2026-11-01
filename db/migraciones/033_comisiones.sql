-- =====================================================================
-- 033 · Comisión de cada vendedor (% sobre sus ventas sin IGV del mes).
-- La pone el dueño en Más → Usuarios. Vacío = sin comisión. El cálculo que
-- se muestra es un ESTIMADO: el pago real lo decide el dueño.
-- =====================================================================
ALTER TABLE usuario_empresa ADD COLUMN comision numeric(5,2) CHECK (comision >= 0 AND comision <= 100);
