-- =====================================================================
-- 048 · Reiniciar los datos de PRUEBA de una empresa (solo en ambiente BETA).
--
-- El dueño pidió (16/11/2026) un botón para "empezar de cero" guardando una copia.
-- La regla del proyecto es "nunca borrar comprobantes", y se mantiene: lo que una
-- empresa envió a SUNAT de verdad (producción) NO se puede reiniciar jamás. Los
-- comprobantes de BETA no tienen valor tributario: son pruebas.
--
-- Cómo se cumple, en la propia base (no depende de que el programa se porte bien):
--   1. Nada se borra sin copiarlo antes: cada fila pasa a `reinicio_filas` y la
--      función compara cuántas copió con cuántas quitó; si no cuadra, no cambia nada.
--   2. Los candados de siempre siguen puestos. Solo se hacen a un lado mientras
--      corre `reinicio_apartar`, para ESA empresa, para las tablas de `reinicio_plan`
--      y solo si la empresa está en BETA. Fuera de eso responden como antes.
--   3. Con un solo comprobante, baja, resumen o envío de PRODUCCIÓN la función se niega.
-- =====================================================================

CREATE TABLE reinicios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id),
  usuario_id  uuid REFERENCES usuarios(id),
  -- REINICIO: lo pidió el dueño. ANTES_DE_RESTAURAR: lo que había al restaurar otra copia.
  motivo      text NOT NULL CHECK (motivo IN ('REINICIO', 'ANTES_DE_RESTAURAR')),
  grupos      text[] NOT NULL,
  -- Número en que iba cada serie: { "<id de la serie>": ultimo_numero }
  series      jsonb NOT NULL,
  -- Cuántas filas se apartaron de cada tabla: { "<tabla>": cantidad }
  resumen     jsonb NOT NULL DEFAULT '{}',
  creado_en   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reinicios_empresa ON reinicios (empresa_id, creado_en DESC);

CREATE TABLE reinicio_filas (
  reinicio_id uuid NOT NULL REFERENCES reinicios(id) ON DELETE CASCADE,
  paso        integer NOT NULL,
  tabla       text NOT NULL,
  fila        jsonb NOT NULL
);
CREATE INDEX reinicio_filas_copia ON reinicio_filas (reinicio_id, paso);

-- ---------------------------------------------------------------------
-- Qué se reinicia, en qué orden y de qué grupo. Es la ÚNICA lista: la usan la copia,
-- el borrado, la restauración, los candados y el panel. Lo que no está aquí no se toca
-- (empresa, series, certificados, productos, proveedores, cuentas, usuarios, llaves,
-- comprobantes antiguos, historial de acciones…).
-- Orden: primero los hijos (así ninguna fila queda apuntando a otra que ya no está).
-- `filtro` se aplica sobre el alias "t"; $1 es la empresa.
-- ---------------------------------------------------------------------
CREATE FUNCTION reinicio_plan() RETURNS TABLE (orden integer, tabla text, grupo text, filtro text)
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    (10,  'baja_items',            'VENTAS',   't.baja_id IN (SELECT id FROM comunicaciones_baja WHERE empresa_id = $1)'),
    (20,  'resumen_items',         'VENTAS',   't.resumen_id IN (SELECT id FROM resumenes_diarios WHERE empresa_id = $1)'),
    (30,  'comunicaciones_baja',   'VENTAS',   't.empresa_id = $1'),
    (40,  'resumenes_diarios',     'VENTAS',   't.empresa_id = $1'),
    (50,  'envios_sunat',          'VENTAS',   't.empresa_id = $1'),
    (60,  'cola_envios',           'VENTAS',   't.empresa_id = $1'),
    (70,  'comprobante_eventos',   'VENTAS',   't.comprobante_id IN (SELECT id FROM comprobantes WHERE empresa_id = $1)'),
    (80,  'comprobante_cuotas',    'VENTAS',   't.comprobante_id IN (SELECT id FROM comprobantes WHERE empresa_id = $1)'),
    (90,  'comprobante_items',     'VENTAS',   't.comprobante_id IN (SELECT id FROM comprobantes WHERE empresa_id = $1)'),
    (100, 'reembolsos',            'VENTAS',   't.empresa_id = $1'),
    (110, 'devolucion_items',      'VENTAS',   't.devolucion_id IN (SELECT id FROM devoluciones WHERE empresa_id = $1)'),
    (120, 'devoluciones',          'VENTAS',   't.empresa_id = $1'),
    (130, 'pagos',                 'VENTAS',   't.empresa_id = $1'),
    (140, 'cotizacion_items',      'VENTAS',   't.cotizacion_id IN (SELECT id FROM cotizaciones WHERE empresa_id = $1)'),
    (150, 'cotizaciones',          'VENTAS',   't.empresa_id = $1'),
    (160, 'cierre_caja_lineas',    'VENTAS',   't.cierre_id IN (SELECT id FROM cierres_caja WHERE empresa_id = $1)'),
    (170, 'cierres_caja',          'VENTAS',   't.empresa_id = $1'),
    -- Lo que salió o volvió por una venta (también las ventas sin internet, que no llevan comprobante).
    (180, 'movimientos_stock',     'VENTAS',   $f$t.empresa_id = $1 AND (t.comprobante_id IS NOT NULL OR t.tipo IN ('VENTA', 'DEVOLUCION', 'ANULACION'))$f$),
    (190, 'informes_contingencia', 'VENTAS',   't.empresa_id = $1'),
    (200, 'ventas_contingencia',   'VENTAS',   't.empresa_id = $1'),
    (210, 'comprobantes',          'VENTAS',   't.empresa_id = $1'),
    -- XML, constancias (CDR) e informes de esos comprobantes. El logo y los comprobantes antiguos se quedan.
    (220, 'archivos_contenido',    'VENTAS',   $f$t.ruta IN (SELECT ruta_almacenamiento FROM archivos WHERE empresa_id = $1 AND entidad IN ('comprobantes', 'resumenes_diarios', 'comunicaciones_baja', 'informes_contingencia'))
                                                 AND NOT EXISTS (SELECT 1 FROM archivos o WHERE o.ruta_almacenamiento = t.ruta
                                                                   AND NOT (o.empresa_id = $1 AND o.entidad IN ('comprobantes', 'resumenes_diarios', 'comunicaciones_baja', 'informes_contingencia')))$f$),
    (230, 'archivos',              'VENTAS',   $f$t.empresa_id = $1 AND t.entidad IN ('comprobantes', 'resumenes_diarios', 'comunicaciones_baja', 'informes_contingencia')$f$),
    (240, 'alertas',               'VENTAS',   't.empresa_id = $1'),
    (250, 'clientes',              'CLIENTES', 't.empresa_id = $1'),
    (260, 'pagos_compra',          'COMPRAS',  't.empresa_id = $1'),
    (270, 'compra_items',          'COMPRAS',  't.compra_id IN (SELECT id FROM compras WHERE empresa_id = $1)'),
    -- El resto del stock: lo que entró por compras y los ajustes a mano.
    (280, 'movimientos_stock',     'COMPRAS',  $f$t.empresa_id = $1 AND t.comprobante_id IS NULL AND t.tipo IN ('COMPRA', 'AJUSTE')$f$),
    (290, 'compras',               'COMPRAS',  't.empresa_id = $1'),
    (300, 'gastos',                'COMPRAS',  't.empresa_id = $1'),
    (310, 'archivos_contenido',    'COMPRAS',  $f$t.ruta IN (SELECT ruta_almacenamiento FROM archivos WHERE empresa_id = $1 AND entidad = 'gastos')
                                                 AND NOT EXISTS (SELECT 1 FROM archivos o WHERE o.ruta_almacenamiento = t.ruta AND NOT (o.empresa_id = $1 AND o.entidad = 'gastos'))$f$),
    (320, 'archivos',              'COMPRAS',  $f$t.empresa_id = $1 AND t.entidad = 'gastos'$f$)
$$;

-- ---------------------------------------------------------------------
-- ¿Se puede reiniciar esta empresa? Devuelve NULL si sí; si no, el motivo en español.
-- ---------------------------------------------------------------------
CREATE FUNCTION reinicio_bloqueo(p_empresa uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_ambiente ambiente_sunat;
BEGIN
  SELECT ambiente_sunat INTO v_ambiente FROM empresas WHERE id = p_empresa;
  IF NOT FOUND THEN RETURN 'La empresa no existe.'; END IF;
  IF v_ambiente <> 'BETA' THEN
    RETURN 'Esta empresa ya emite comprobantes reales (producción). Los comprobantes enviados a SUNAT no se borran: se corrigen con nota de crédito o se anulan.';
  END IF;
  IF EXISTS (SELECT 1 FROM comprobantes WHERE empresa_id = p_empresa AND ambiente_sunat = 'PRODUCCION')
     OR EXISTS (SELECT 1 FROM comunicaciones_baja WHERE empresa_id = p_empresa AND ambiente_sunat = 'PRODUCCION')
     OR EXISTS (SELECT 1 FROM resumenes_diarios WHERE empresa_id = p_empresa AND ambiente_sunat = 'PRODUCCION')
     OR EXISTS (SELECT 1 FROM envios_sunat WHERE empresa_id = p_empresa AND ambiente = 'PRODUCCION') THEN
    RETURN 'Esta empresa tiene comprobantes reales enviados a SUNAT (producción). No se puede reiniciar.';
  END IF;
  IF EXISTS (SELECT 1 FROM cola_envios WHERE empresa_id = p_empresa AND estado = 'PROCESANDO' AND bloqueado_hasta > now()) THEN
    RETURN 'Hay un envío a SUNAT en curso. Espera un minuto y vuelve a intentarlo.';
  END IF;
  RETURN NULL;
END $$;

-- ¿Está corriendo ahora mismo un reinicio permitido para esta empresa? Lo consultan los
-- candados. La marca la pone `reinicio_apartar` y dura solo lo que dura su trabajo.
-- Aunque alguien pusiera la marca a mano, con la empresa en producción responde que no.
CREATE FUNCTION reinicio_en_curso(p_empresa text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_marca text := coalesce(current_setting('facturador.reinicio', true), '');
BEGIN
  IF v_marca = '' THEN RETURN false; END IF;
  IF p_empresa IS NOT NULL AND p_empresa <> v_marca THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM empresas WHERE id = v_marca::uuid AND ambiente_sunat = 'BETA');
END $$;

-- ---------------------------------------------------------------------
-- Los candados de siempre, con la única excepción del reinicio de pruebas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION impedir_borrado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF reinicio_en_curso(to_jsonb(OLD) ->> 'empresa_id') AND EXISTS (SELECT 1 FROM reinicio_plan() WHERE tabla = TG_TABLE_NAME) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'No se permite borrar registros de %: corrige con nota de crédito o baja.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE OR REPLACE FUNCTION impedir_modificacion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND reinicio_en_curso(to_jsonb(OLD) ->> 'empresa_id')
     AND EXISTS (SELECT 1 FROM reinicio_plan() WHERE tabla = TG_TABLE_NAME) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'La tabla % es de solo inserción.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE OR REPLACE FUNCTION series_no_retroceder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ultimo_numero < OLD.ultimo_numero AND NOT reinicio_en_curso(OLD.empresa_id::text) THEN
    RAISE EXCEPTION 'El correlativo de la serie % no puede retroceder.', OLD.serie USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.serie <> OLD.serie OR NEW.tipo_comprobante <> OLD.tipo_comprobante OR NEW.empresa_id <> OLD.empresa_id THEN
    RAISE EXCEPTION 'No se puede cambiar la identidad de una serie.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION cotizaciones_solo_estado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF reinicio_en_curso(OLD.empresa_id::text) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Una cotización no se borra: se anula.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.empresa_id, NEW.numero, NEW.fecha, NEW.valida_hasta, NEW.cliente_documento, NEW.cliente_numero, NEW.cliente_nombre, NEW.nota, NEW.total, NEW.usuario_id, NEW.creado_en)
     IS DISTINCT FROM (OLD.empresa_id, OLD.numero, OLD.fecha, OLD.valida_hasta, OLD.cliente_documento, OLD.cliente_numero, OLD.cliente_nombre, OLD.nota, OLD.total, OLD.usuario_id, OLD.creado_en)
     OR OLD.estado <> 'VIGENTE' THEN
    RAISE EXCEPTION 'Una cotización enviada no se modifica; anúlala y haz otra.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION gastos_solo_anular() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF reinicio_en_curso(OLD.empresa_id::text) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Un gasto no se borra: se anula con un motivo.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.empresa_id, NEW.fecha, NEW.monto, NEW.categoria, NEW.descripcion, NEW.medio, NEW.cuenta_id, NEW.documento, NEW.registrado_por, NEW.creado_en)
     IS DISTINCT FROM (OLD.empresa_id, OLD.fecha, OLD.monto, OLD.categoria, OLD.descripcion, OLD.medio, OLD.cuenta_id, OLD.documento, OLD.registrado_por, OLD.creado_en)
     OR OLD.anulado_en IS NOT NULL THEN
    RAISE EXCEPTION 'Un gasto registrado no se modifica; anúlalo con un motivo y registra el correcto.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pagos_compra_solo_anular() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF reinicio_en_curso(OLD.empresa_id::text) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Un pago a proveedor no se borra: se anula con un motivo.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.empresa_id, NEW.compra_id, NEW.fecha, NEW.monto, NEW.medio, NEW.cuenta_id, NEW.referencia, NEW.registrado_por, NEW.creado_en)
     IS DISTINCT FROM (OLD.empresa_id, OLD.compra_id, OLD.fecha, OLD.monto, OLD.medio, OLD.cuenta_id, OLD.referencia, OLD.registrado_por, OLD.creado_en)
     OR OLD.anulado_en IS NOT NULL THEN
    RAISE EXCEPTION 'Un pago a proveedor no se modifica; anúlalo con un motivo y registra el correcto.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- El trabajo: copiar, quitar y volver la numeración a cero. Devuelve el id de la copia.
-- ---------------------------------------------------------------------
CREATE FUNCTION reinicio_apartar(p_empresa uuid, p_usuario uuid, p_grupos text[], p_motivo text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_bloqueo text;
  v_copia   uuid;
  v_resumen jsonb := '{}';
  v_paso    record;
  v_copiadas bigint;
  v_quitadas bigint;
BEGIN
  -- Con la empresa bloqueada nadie emite, cobra ni registra nada suyo hasta que esto termine.
  PERFORM 1 FROM empresas WHERE id = p_empresa FOR UPDATE;
  v_bloqueo := reinicio_bloqueo(p_empresa);
  IF v_bloqueo IS NOT NULL THEN
    RAISE EXCEPTION '%', v_bloqueo USING ERRCODE = 'restrict_violation';
  END IF;
  IF p_grupos IS NULL OR NOT ('VENTAS' = ANY (p_grupos)) OR NOT (p_grupos <@ ARRAY['VENTAS', 'CLIENTES', 'COMPRAS']) THEN
    RAISE EXCEPTION 'Grupos no válidos para reiniciar.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM series WHERE empresa_id = p_empresa FOR UPDATE;

  INSERT INTO reinicios (empresa_id, usuario_id, motivo, grupos, series)
  VALUES (p_empresa, p_usuario, p_motivo, p_grupos,
          coalesce((SELECT jsonb_object_agg(id::text, ultimo_numero) FROM series WHERE empresa_id = p_empresa), '{}'))
  RETURNING id INTO v_copia;

  -- 1) Copiar TODO antes de quitar nada.
  FOR v_paso IN SELECT * FROM reinicio_plan() WHERE grupo = ANY (p_grupos) ORDER BY orden LOOP
    EXECUTE format('INSERT INTO reinicio_filas (reinicio_id, paso, tabla, fila) SELECT $2, %s, %L, to_jsonb(t) FROM %I t WHERE %s',
                   v_paso.orden, v_paso.tabla, v_paso.tabla, v_paso.filtro) USING p_empresa, v_copia;
    GET DIAGNOSTICS v_copiadas = ROW_COUNT;
    v_resumen := v_resumen || jsonb_build_object(v_paso.tabla, coalesce((v_resumen ->> v_paso.tabla)::bigint, 0) + v_copiadas);
  END LOOP;

  -- 2) Quitar, con los candados a un lado solo para esta empresa y solo aquí dentro.
  PERFORM set_config('facturador.reinicio', p_empresa::text, true);
  FOR v_paso IN SELECT * FROM reinicio_plan() WHERE grupo = ANY (p_grupos) ORDER BY orden LOOP
    EXECUTE format('DELETE FROM %I t WHERE %s', v_paso.tabla, v_paso.filtro) USING p_empresa;
    GET DIAGNOSTICS v_quitadas = ROW_COUNT;
    SELECT count(*) INTO v_copiadas FROM reinicio_filas WHERE reinicio_id = v_copia AND paso = v_paso.orden;
    IF v_quitadas <> v_copiadas THEN
      RAISE EXCEPTION 'La copia de % no coincide con lo que se iba a quitar (% copiadas, % quitadas). No se cambió nada; vuelve a intentarlo.',
        v_paso.tabla, v_copiadas, v_quitadas USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  UPDATE series SET ultimo_numero = 0 WHERE empresa_id = p_empresa AND ultimo_numero <> 0;
  PERFORM set_config('facturador.reinicio', '', true);

  UPDATE reinicios SET resumen = v_resumen WHERE id = v_copia;
  RETURN v_copia;
END $$;

-- Se guardan las 3 últimas copias de cada empresa; las anteriores se eliminan (llevan datos de clientes).
CREATE FUNCTION reinicio_podar(p_empresa uuid) RETURNS void
LANGUAGE sql AS $$
  DELETE FROM reinicios WHERE empresa_id = p_empresa
     AND id NOT IN (SELECT id FROM reinicios WHERE empresa_id = p_empresa ORDER BY creado_en DESC, id LIMIT 3)
$$;

CREATE FUNCTION reiniciar_empresa(p_empresa uuid, p_usuario uuid, p_grupos text[]) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_copia uuid;
BEGIN
  v_copia := reinicio_apartar(p_empresa, p_usuario, p_grupos, 'REINICIO');
  INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues)
  SELECT p_empresa, p_usuario, 'REINICIAR_DATOS_DE_PRUEBA', 'reinicios', v_copia,
         jsonb_build_object('grupos', to_jsonb(grupos), 'apartado', resumen, 'series', series)
    FROM reinicios WHERE id = v_copia;
  PERFORM reinicio_podar(p_empresa);
  RETURN v_copia;
END $$;

-- Restaurar una copia: lo que haya ahora se aparta primero en OTRA copia (nada se pierde),
-- luego vuelven las filas guardadas y la numeración de entonces. La copia restaurada
-- desaparece de la lista: sus datos ya están otra vez en su sitio.
CREATE FUNCTION restaurar_reinicio(p_empresa uuid, p_usuario uuid, p_copia uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_copia  reinicios%ROWTYPE;
  v_previa uuid;
  v_paso   record;
BEGIN
  PERFORM 1 FROM empresas WHERE id = p_empresa FOR UPDATE;
  SELECT * INTO v_copia FROM reinicios WHERE id = p_copia AND empresa_id = p_empresa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Esa copia ya no existe.' USING ERRCODE = 'no_data_found';
  END IF;
  v_previa := reinicio_apartar(p_empresa, p_usuario, v_copia.grupos, 'ANTES_DE_RESTAURAR');

  -- Primero los padres: el orden contrario al de quitar.
  FOR v_paso IN SELECT * FROM reinicio_plan() WHERE grupo = ANY (v_copia.grupos) ORDER BY orden DESC LOOP
    EXECUTE format('INSERT INTO %I OVERRIDING SYSTEM VALUE SELECT r.* FROM reinicio_filas f, jsonb_populate_record(NULL::%I, f.fila) r WHERE f.reinicio_id = $1 AND f.paso = $2',
                   v_paso.tabla, v_paso.tabla) USING p_copia, v_paso.orden;
  END LOOP;
  UPDATE series s SET ultimo_numero = (v_copia.series ->> s.id::text)::bigint
   WHERE s.empresa_id = p_empresa AND v_copia.series ? s.id::text;

  INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, antes, despues)
  VALUES (p_empresa, p_usuario, 'RESTAURAR_COPIA_DE_REINICIO', 'reinicios', p_copia,
          jsonb_build_object('copia_de_lo_que_habia', v_previa),
          jsonb_build_object('grupos', to_jsonb(v_copia.grupos), 'devuelto', v_copia.resumen, 'copia_del', v_copia.creado_en));
  DELETE FROM reinicios WHERE id = p_copia;
  PERFORM reinicio_podar(p_empresa);
  RETURN v_previa;
END $$;

-- Cuánto hay hoy de cada cosa (para que el dueño vea qué se va a quitar antes de confirmar).
CREATE FUNCTION reinicio_conteo(p_empresa uuid) RETURNS TABLE (grupo text, tabla text, filas bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_paso record;
BEGIN
  FOR v_paso IN SELECT * FROM reinicio_plan() ORDER BY orden LOOP
    grupo := v_paso.grupo;
    tabla := v_paso.tabla;
    EXECUTE format('SELECT count(*) FROM %I t WHERE %s', v_paso.tabla, v_paso.filtro) INTO filas USING p_empresa;
    RETURN NEXT;
  END LOOP;
END $$;
