-- =====================================================================
-- 038 · Plazo para ENVIAR una boleta sola a SUNAT (no en resumen diario).
-- El facturador manda cada boleta por separado (sendBill). El plazo de 7 días
-- confirmado es el del RESUMEN DIARIO (orientacion.sunat.gob.pe, 04/11/2026);
-- para el envío individual por SEE - Del Contribuyente no se encontró el texto
-- vigente (por OSE, SUNAT indica 5 días). Mientras se confirma, se usa el plazo
-- de la factura (3 días): es el más corto, así una boleta nunca llega tarde.
-- Si el contador o SUNAT confirman otro valor, se agrega una fila nueva con su
-- fecha de vigencia (no se edita esta).
-- =====================================================================
INSERT INTO parametros_tributarios (codigo, regimen, valor, vigente_desde, fuente) VALUES
  ('PLAZO_ENVIO_BOLETA_DIAS', NULL, 3, '2019-01-01',
   'PROVISIONAL Y CONSERVADOR (04/11/2026): envío individual de boletas por SEE - Del Contribuyente. '
   'Confirmado: resumen diario 7 días (orientacion.sunat.gob.pe); OSE individual 5 días (cpe.sunat.gob.pe). '
   'Se usa 3 (como la factura) hasta confirmar el texto vigente.');
