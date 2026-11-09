-- =====================================================================
-- 046 · Nota de débito (08): cobrar algo más sobre una factura o boleta ya
-- emitida (intereses por mora, aumento en el valor, penalidades / otros
-- conceptos; catálogo 10 del Anexo 8, R.S. 245-2017/SUNAT, leído el
-- 09/11/2026). Como la nota de crédito, modifica UN comprobante y lleva
-- su motivo; las series empiezan con F (de factura) o B (de boleta).
-- =====================================================================

-- La nota de débito también lleva comprobante de referencia y motivo. La regla que
-- lo exigía solo a la de crédito se busca por su contenido (su nombre lo puso PostgreSQL).
DO $$
DECLARE
  nombre text;
BEGIN
  SELECT conname INTO nombre FROM pg_constraint
   WHERE conrelid = 'comprobantes'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%comprobante_referencia_id IS NOT NULL%motivo_nota_codigo IS NOT NULL%';
  IF nombre IS NULL THEN
    RAISE EXCEPTION 'No se encontró la regla de referencia de las notas de crédito.';
  END IF;
  EXECUTE format('ALTER TABLE comprobantes DROP CONSTRAINT %I', nombre);
END $$;
ALTER TABLE comprobantes ADD CONSTRAINT comprobantes_nota_con_referencia
  CHECK ((tipo_comprobante IN ('07', '08')) = (comprobante_referencia_id IS NOT NULL AND motivo_nota_codigo IS NOT NULL));

INSERT INTO regimen_comprobantes_permitidos (regimen, tipo_comprobante, permitido, fuente) VALUES
  ('RER', '08', true, 'Reglamento de Comprobantes de Pago'),
  ('MYPE_TRIBUTARIO', '08', true, 'Reglamento de Comprobantes de Pago'),
  ('GENERAL', '08', true, 'Reglamento de Comprobantes de Pago'),
  ('NUEVO_RUS', '08', true, 'POR VERIFICAR: nota de débito de boletas (igual que la nota de crédito).')
ON CONFLICT DO NOTHING;

-- Series de nota de débito para las empresas que ya existen (las nuevas las crean al configurarse).
INSERT INTO series (empresa_id, tipo_comprobante, serie)
SELECT e.id, '08', s.serie FROM empresas e CROSS JOIN (VALUES ('FD01'), ('BD01')) AS s(serie)
ON CONFLICT (empresa_id, tipo_comprobante, serie) DO NOTHING;
