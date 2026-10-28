-- =====================================================================
-- 021 · Plataforma: el facturador como servicio para otros negocios.
--   - planes: precio mensual/anual y límites (comprobantes al mes, usuarios).
--   - suscripciones: qué plan tiene cada empresa y hasta cuándo está pagado.
--   - pagos_suscripcion: historial de lo que pagó cada cliente (solo inserción).
--   - errores_plataforma: errores internos, para avisar al administrador.
--   - avisos_plataforma: avisos al administrador ya enviados (uno por clave).
-- Una empresa SIN suscripción es propia (del dueño de la plataforma): sin límites.
-- Los precios son PROPUESTAS iniciales: se cambian desde el panel de la plataforma.
-- =====================================================================

CREATE TABLE planes (
  codigo           text PRIMARY KEY CHECK (codigo ~ '^[A-Z_]{3,20}$'),
  nombre           text NOT NULL,
  precio_mensual   numeric(10,2) NOT NULL CHECK (precio_mensual >= 0),
  precio_anual     numeric(10,2) NOT NULL CHECK (precio_anual >= 0),
  -- NULL = sin límite.
  comprobantes_mes integer CHECK (comprobantes_mes > 0),
  usuarios_max     integer CHECK (usuarios_max > 0),
  activo           boolean NOT NULL DEFAULT true,
  creado_en        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO planes (codigo, nombre, precio_mensual, precio_anual, comprobantes_mes, usuarios_max) VALUES
  ('EMPRENDEDOR', 'Emprendedor', 39.00, 390.00, 150, 2),
  ('NEGOCIO', 'Negocio', 69.00, 690.00, 600, 5),
  ('EMPRESA', 'Empresa', 119.00, 1190.00, NULL, NULL);

CREATE TABLE suscripciones (
  empresa_id    uuid PRIMARY KEY REFERENCES empresas(id),
  plan_codigo   text NOT NULL REFERENCES planes(codigo),
  -- VENCIDA no se guarda: se deduce de vence_en + dias_gracia.
  estado        text NOT NULL CHECK (estado IN ('PRUEBA', 'ACTIVA', 'SUSPENDIDA', 'CANCELADA')),
  vence_en      date NOT NULL,
  -- Días después del vencimiento en que todavía puede emitir (con aviso).
  dias_gracia   integer NOT NULL DEFAULT 5 CHECK (dias_gracia BETWEEN 0 AND 60),
  -- Correo y teléfono de quien paga (para avisarle y cobrarle).
  contacto      text,
  notas         text,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pagos_suscripcion (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id     uuid NOT NULL REFERENCES empresas(id),
  plan_codigo    text NOT NULL REFERENCES planes(codigo),
  periodo        text NOT NULL CHECK (periodo IN ('MENSUAL', 'ANUAL')),
  monto          numeric(10,2) NOT NULL CHECK (monto >= 0),
  medio          text NOT NULL,
  referencia     text,
  desde          date NOT NULL,
  hasta          date NOT NULL CHECK (hasta > desde),
  registrado_por uuid REFERENCES usuarios(id),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pagos_suscripcion_empresa ON pagos_suscripcion (empresa_id, creado_en);
-- Un pago registrado no se cambia ni se borra: si hubo un error se registra otro (con monto 0 y nota).
CREATE TRIGGER pagos_suscripcion_solo_insercion BEFORE UPDATE OR DELETE ON pagos_suscripcion
  FOR EACH ROW EXECUTE FUNCTION impedir_modificacion();

CREATE TABLE errores_plataforma (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origen      text NOT NULL,
  mensaje     text NOT NULL,
  ruta        text,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  avisado_en  timestamptz
);
CREATE INDEX errores_plataforma_recientes ON errores_plataforma (creado_en);

CREATE TABLE avisos_plataforma (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo       text NOT NULL,
  clave      text NOT NULL,
  enviado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tipo, clave)
);
