-- =====================================================================
-- 040 · Vender sin internet: boletas y facturas IMPRESAS de contingencia.
--
-- Cuando no se puede emitir electrónicamente por una causa que no es culpa del
-- emisor (ej. se cayó el internet), SUNAT permite entregar comprobantes impresos
-- por imprenta autorizada (serie numérica, ej. 0001-123) e informarlos dentro de
-- los 7 días calendario siguientes. Fuentes (consultadas el 07/11/2026):
--   - R.S. 113-2018/SUNAT (modifica la R.S. 300-2014): requisitos y plazo de 7 días.
--   - Guía "Resumen de comprobantes impresos" v1.1 y Anexo II de la R.S. 254-2018:
--     archivo RUC-RF-DDMMAAAA-NN.TXT en ZIP, campos separados por "|"; motivo
--     1 = Conexión a internet. Se carga en SOL → Contingencia de Comprobantes de Pago.
--
-- El celular las guarda mientras no hay señal y las manda al volver. Son ventas de
-- verdad: cuentan en el tablero y en el Excel del contador. Solo inserción.
-- =====================================================================

CREATE TABLE ventas_contingencia (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id),
  -- Lo genera el celular: si la venta llega dos veces (se cortó la señal al enviarla), no se duplica.
  origen           text NOT NULL CHECK (length(origen) BETWEEN 8 AND 100),
  tipo             char(2) NOT NULL CHECK (tipo IN ('01', '03')),
  serie            varchar(4) NOT NULL CHECK (serie ~ '^[0-9]{4}$'),
  numero           integer NOT NULL CHECK (numero BETWEEN 1 AND 99999999),
  fecha_emision    date NOT NULL,
  hora_emision     time NOT NULL,
  motivo           smallint NOT NULL DEFAULT 1 CHECK (motivo BETWEEN 1 AND 7),
  cliente_tipo_doc text NOT NULL,
  cliente_doc      text NOT NULL,
  cliente_nombre   text NOT NULL,
  moneda           char(3) NOT NULL DEFAULT 'PEN',
  total_gravado    numeric(14,2) NOT NULL CHECK (total_gravado >= 0),
  total_exonerado  numeric(14,2) NOT NULL CHECK (total_exonerado >= 0),
  total_inafecto   numeric(14,2) NOT NULL CHECK (total_inafecto >= 0),
  total_igv        numeric(14,2) NOT NULL CHECK (total_igv >= 0),
  importe_total    numeric(14,2) NOT NULL CHECK (importe_total > 0),
  items            jsonb NOT NULL,
  medio_pago       text,
  canal_id         uuid REFERENCES canales(id),
  registrado_por   uuid REFERENCES usuarios(id),
  -- Cuándo se anotó en el celular y cuándo llegó al facturador.
  anotado_en       timestamptz NOT NULL,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, origen),
  UNIQUE (empresa_id, tipo, serie, numero)
);
CREATE INDEX ventas_contingencia_fecha ON ventas_contingencia (empresa_id, fecha_emision);
CREATE TRIGGER ventas_contingencia_solo_insercion BEFORE UPDATE OR DELETE ON ventas_contingencia
  FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();

-- Cada archivo RF generado para SUNAT (uno por fecha de emisión; el último reemplaza al anterior).
CREATE TABLE informes_contingencia (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  fecha_emision  date NOT NULL,
  correlativo    smallint NOT NULL CHECK (correlativo BETWEEN 1 AND 99),
  ventas         uuid[] NOT NULL,
  archivo_id     uuid NOT NULL REFERENCES archivos(id),
  generado_por   uuid REFERENCES usuarios(id),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, fecha_emision, correlativo)
);
CREATE TRIGGER informes_contingencia_solo_insercion BEFORE UPDATE OR DELETE ON informes_contingencia
  FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();

-- Plazo para informarlas a SUNAT (parámetro con vigencia, nunca fijo en el código).
INSERT INTO parametros_tributarios (codigo, regimen, valor, vigente_desde, fuente) VALUES
  ('PLAZO_INFORMAR_CONTINGENCIA_DIAS', NULL, 7, '2018-05-01',
   'R.S. 113-2018/SUNAT, inciso 4.2.4 b.1): el día de emisión o hasta el sétimo día calendario siguiente (consultado 07/11/2026).');
