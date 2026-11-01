-- =====================================================================
-- 030 · Fondo inicial de caja.
-- El cajón no empieza en cero: queda sencillo del día anterior. Cada línea
-- del cierre guarda con cuánto empezó la cuenta ese día; lo que debería
-- haber al cerrar = fondo + cobros − gastos.
-- =====================================================================
ALTER TABLE cierre_caja_lineas ADD COLUMN fondo numeric(14,2) NOT NULL DEFAULT 0 CHECK (fondo >= 0);
