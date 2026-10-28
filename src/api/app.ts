/**
 * API HTTP del facturador (ver docs/API.md).
 *
 * Autenticación: "Authorization: Bearer fk_…" (una llave por canal).
 * Todo lo que se consulta queda limitado a la empresa de la llave: un comprobante de
 * otra empresa responde 404, igual que uno inexistente.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { Almacen } from '../almacen/almacen.js';
import { enviarAvisos, type EnviarCorreo } from '../avisos/avisos.js';
import { procesarAhora, procesarCola, type ServiciosEnvio } from '../cola/procesar.js';
import { MEDIOS_PAGO, estadoCobro, pagosDe, registrarPago, revisarVencimientos, type MedioPago } from '../cobros/pagos.js';
import { solicitarAnulacion } from '../comprobantes/anular.js';
import { emitirComprobante } from '../comprobantes/emitir.js';
import { esFormatoPdf, pdfDeComprobante } from '../comprobantes/pdf-comprobante.js';
import { cargarComprobante } from '../comprobantes/repositorio.js';
import type { Db } from '../db/conexion.js';
import { sumar } from '../dinero.js';
import { ErrorPdf } from '../pdf/representacion.js';
import { resumenDelDia } from '../reportes/resumen-dia.js';
import { idComprobanteLegible } from '../tipos.js';
import { autenticarLlave, type ContextoLlave, type Permiso } from './llaves.js';
import { leerToken, tokenComprobante } from './enlaces.js';
import { leerPedido } from './solicitud.js';
import { registrarPanel } from '../panel/rutas.js';

export interface DependenciasApi {
  db: Db;
  servicios: ServiciosEnvio & { almacen: Almacen };
  /** Clave para el endpoint del cron (Vercel la envía como "Authorization: Bearer …"). */
  claveCron?: string;
  /** Clave de la primera configuración del panel (crear el primer usuario sin la PC). Mínimo 16 caracteres. */
  claveInstalacion?: string;
  /** Clave para recuperar el acceso (contraseña olvidada o celular perdido). Mínimo 16 caracteres. */
  claveRecuperacion?: string;
  /** Enviar a SUNAT apenas se emite (por defecto sí). */
  enviarAlEmitir?: boolean;
  /** Pedidos por minuto por llave. */
  limitePorMinuto?: number;
  /** Intentos con llave o clave equivocada permitidos por minuto y por dirección (20). */
  fallosPorMinuto?: number;
  /** Envío de avisos por correo (vencimientos, certificado, rechazos). Sin esto, no se envían. */
  correo?: EnviarCorreo;
}

type Variables = { llave: ContextoLlave };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function error(c: Context, estado: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, codigo: string, mensaje: string, detalles?: string[]) {
  return c.json({ error: { codigo, mensaje, ...(detalles ? { detalles } : {}) } }, estado);
}

/** Límite simple en memoria por llave. En varias instancias es aproximado (suficiente como freno). */
/** Cuenta eventos por clave en ventanas de un minuto. */
function crearLimitador(porMinuto: number) {
  const ventanas = new Map<string, { inicio: number; cuenta: number }>();
  const vigente = (clave: string, ahora: number) => {
    const v = ventanas.get(clave);
    return v && ahora - v.inicio < 60_000 ? v : undefined;
  };
  return {
    /** Suma uno; false si con este se pasó del límite. */
    contar(clave: string): boolean {
      const ahora = Date.now();
      // Sin limpieza, quien pruebe desde miles de direcciones haría crecer esta tabla sin fin.
      if (ventanas.size > 10_000) {
        for (const [k, v] of ventanas) if (ahora - v.inicio >= 60_000) ventanas.delete(k);
      }
      const v = vigente(clave, ahora);
      if (!v) {
        ventanas.set(clave, { inicio: ahora, cuenta: 1 });
        return 1 <= porMinuto;
      }
      v.cuenta++;
      return v.cuenta <= porMinuto;
    },
    /** ¿Ya se pasó del límite en este minuto? (sin contar) */
    excedido(clave: string): boolean {
      return (vigente(clave, Date.now())?.cuenta ?? 0) >= porMinuto;
    },
  };
}

/**
 * Dirección de quien llama. Detrás de Render, el proxy AGREGA la IP real al final de
 * X-Forwarded-For; lo de antes lo puede inventar el cliente, así que se toma la última.
 */
function ipCliente(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'directo';
}

function igualesEnTiempoConstante(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function crearApp(dep: DependenciasApi): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  const permitir = crearLimitador(dep.limitePorMinuto ?? 120);
  // Límite de intentos: quien falla la llave muchas veces seguidas queda frenado un minuto,
  // así no puede probar llaves (ni cargar la base) sin fin.
  const fallos = crearLimitador(dep.fallosPorMinuto ?? 20);
  const frenado = (c: Context) => error(c, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos fallidos; espera un minuto.');

  app.use('*', secureHeaders());

  app.onError((e, c) => {
    console.error('[api] error interno:', e instanceof Error ? e.message : e);
    return error(c, 500, 'ERROR_INTERNO', 'Ocurrió un error interno. El pedido no se perdió si ya fue registrado; vuelve a consultar.');
  });
  app.notFound((c) => error(c, 404, 'NO_ENCONTRADO', 'La ruta no existe.'));

  app.get('/v1/salud', async (c) => {
    try {
      await dep.db.query('SELECT 1');
      return c.json({ ok: true });
    } catch {
      return error(c, 503, 'SIN_BASE_DE_DATOS', 'No hay conexión con la base de datos.');
    }
  });

  // Cron: procesa la cola de envíos. Protegido con su propia clave, no con llaves de canal.
  app.post('/v1/cola/procesar', async (c) => {
    const recibida = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!dep.claveCron || !igualesEnTiempoConstante(recibida, dep.claveCron)) {
      return fallos.contar(ipCliente(c)) ? error(c, 401, 'NO_AUTORIZADO', 'Clave de cron inválida.') : frenado(c);
    }
    const cola = await procesarCola(dep.db, dep.servicios);
    const cuotasRevisadas = await revisarVencimientos(dep.db);
    // Un correo que falla no debe frenar la cola: se registra y se reintenta en la próxima pasada.
    const avisosEnviados = dep.correo
      ? await enviarAvisos(dep.db, dep.correo).catch((e: unknown) => (console.error('[avisos]', e instanceof Error ? e.message : e), 0))
      : 0;
    return c.json({ ...cola, cuotasRevisadas, avisosEnviados });
  });

  // Enlace del cliente: ver el PDF sin llave de API, solo con un enlace firmado (ver enlaces.ts).
  app.get('/c/:token', async (c) => {
    const ip = ipCliente(c);
    if (fallos.excedido(ip)) return frenado(c);
    const id = leerToken(dep.servicios.llaveMaestra, c.req.param('token'));
    if (!id) return fallos.contar(ip) ? error(c, 404, 'NO_ENCONTRADO', 'Enlace inválido o vencido.') : frenado(c);
    try {
      const r = await pdfDeComprobante(dep.db, id, { almacen: dep.servicios.almacen });
      return c.body(new Uint8Array(r.pdf), 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${r.nombreArchivo}"`,
        'Cache-Control': 'private, no-store',
      });
    } catch (e) {
      if (e instanceof ErrorPdf) return error(c, 409, 'PDF_NO_DISPONIBLE', e.message);
      throw e;
    }
  });

  // Todo lo demás requiere una llave de canal. Se registra UNA vez para "/v1/*": registrarlo
  // también en rutas más específicas autenticaría y contaría doble cada pedido.
  const PUBLICAS = new Set(['/v1/salud', '/v1/cola/procesar']);
  const limiteCuerpo = bodyLimit({ maxSize: 100 * 1024, onError: (c) => error(c, 413, 'DEMASIADO_GRANDE', 'El pedido supera los 100 KB.') });
  const autenticar = async (c: Context<{ Variables: Variables }>, next: () => Promise<void>) => {
    if (PUBLICAS.has(c.req.path)) return next();
    const ip = ipCliente(c);
    // Ya frenado: se responde sin tocar la base de datos.
    if (fallos.excedido(ip)) return frenado(c);
    const llave = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    const ctx = llave ? await autenticarLlave(dep.db, llave) : undefined;
    if (!ctx) return fallos.contar(ip) ? error(c, 401, 'NO_AUTORIZADO', 'Llave de API inválida o revocada.') : frenado(c);
    if (!permitir.contar(ctx.apiLlaveId)) return error(c, 429, 'DEMASIADOS_PEDIDOS', 'Demasiados pedidos por minuto; espera un momento.');
    c.set('llave', ctx);
    await next();
    return undefined;
  };
  app.use('/v1/*', limiteCuerpo, autenticar);

  const requiere = (c: Context<{ Variables: Variables }>, p: Permiso) =>
    c.get('llave').permisos.includes(p) ? undefined : error(c, 403, 'SIN_PERMISO', `Esta llave no tiene el permiso "${p}".`);

  /** El comprobante debe existir y ser de la empresa de la llave; si no, 404. */
  async function comprobanteDeLaLlave(c: Context<{ Variables: Variables }>): Promise<string | undefined> {
    const id = c.req.param('id') ?? '';
    if (!UUID.test(id)) return undefined;
    const r = await dep.db.query(`SELECT 1 FROM comprobantes WHERE id = $1 AND empresa_id = $2`, [id, c.get('llave').empresaId]);
    return r.rowCount ? id : undefined;
  }

  async function respuestaComprobante(peticion: Context, id: string) {
    // Dirección pública del facturador. Detrás de Render el servidor recibe http; el
    // cliente llegó por https (lo dice X-Forwarded-Proto).
    const url = new URL(peticion.req.url);
    const base = `${peticion.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1)}://${url.host}`;
    const g = await cargarComprobante(dep.db, id);
    const extra = await dep.db.query(
      `SELECT pedido_externo_id, sunat_codigo_respuesta, sunat_mensaje, sunat_observaciones, estado_pago FROM comprobantes WHERE id = $1`,
      [id],
    );
    const e = extra.rows[0];
    const c = g.comprobante;
    const cobro = await estadoCobro(dep.db, id);
    return {
      id,
      pedido: e.pedido_externo_id,
      numero: idComprobanteLegible(c.serie, c.numero),
      tipo: c.tipo,
      fecha: c.fechaEmision,
      estado: g.estado,
      estadoPago: e.estado_pago,
      total: c.totales.importeTotal.toFixed(2),
      // Descuento global con IGV: lo que se rebajó de la suma de los ítems.
      descuento: sumar(c.items.map((i) => i.total)).minus(c.totales.importeTotal).toFixed(2),
      saldo: cobro.saldo.toFixed(2),
      pagos: await pagosDe(dep.db, id),
      igv: c.totales.igv.toFixed(2),
      sunat: e.sunat_codigo_respuesta ? { codigo: e.sunat_codigo_respuesta, mensaje: e.sunat_mensaje, observaciones: e.sunat_observaciones ?? [] } : null,
      enlaces: {
        pdf: `/v1/comprobantes/${id}/pdf`, xml: `/v1/comprobantes/${id}/xml`, cdr: `/v1/comprobantes/${id}/cdr`,
        // Para el cliente: abre el PDF sin llave (firmado, vence en un año).
        cliente: `${base}/c/${tokenComprobante(dep.servicios.llaveMaestra, id)}`,
      },
    };
  }

  /**
   * Emite (o devuelve el ya emitido), lo envía a SUNAT al instante y registra el pago si
   * vino. Lo usan la API (llave de canal) y el panel (usuario): un solo camino para los dos.
   */
  async function emitirYResponder(
    c: Context,
    quien: { empresaId: string; canalId: string; apiLlaveId?: string; usuarioId?: string },
    cuerpo: unknown,
    puedeCobrar: boolean,
  ) {
    const leido = leerPedido(cuerpo);
    if (!leido.ok) return error(c, 422, 'DATOS_INVALIDOS', 'Revisa los datos del comprobante.', leido.errores);
    if (leido.valor.pago && !puedeCobrar) return error(c, 403, 'SIN_PERMISO', 'Esta llave no tiene el permiso "cobrar".');

    let marcaId: string | undefined;
    if (leido.valor.marca) {
      const m = await dep.db.query(`SELECT id FROM marcas WHERE empresa_id = $1 AND lower(nombre) = lower($2) AND activa`, [quien.empresaId, leido.valor.marca]);
      if (!m.rows[0]) return error(c, 422, 'DATOS_INVALIDOS', 'Revisa los datos del comprobante.', [`marca: no existe la marca "${leido.valor.marca}".`]);
      marcaId = m.rows[0].id as string;
    } else {
      const m = await dep.db.query(`SELECT marca_id_por_defecto FROM canales WHERE id = $1`, [quien.canalId]);
      marcaId = (m.rows[0]?.marca_id_por_defecto as string | null) ?? undefined;
    }

    const autor = { ...(quien.apiLlaveId ? { apiLlaveId: quien.apiLlaveId } : {}), ...(quien.usuarioId ? { usuarioId: quien.usuarioId } : {}) };
    const r = await emitirComprobante(dep.db, {
      empresaId: quien.empresaId,
      canalId: quien.canalId,
      ...autor,
      pedidoExternoId: leido.valor.pedido,
      solicitud: leido.valor.solicitud,
      ...(marcaId ? { marcaId } : {}),
    });
    if (r.resultado === 'ERROR_VALIDACION') return error(c, 422, 'DATOS_INVALIDOS', 'Revisa los datos del comprobante.', r.errores);

    if (r.resultado === 'EMITIDO' && dep.enviarAlEmitir !== false) {
      // Intento inmediato; si SUNAT no responde, queda en la cola y se reintenta solo.
      await procesarAhora(dep.db, dep.servicios, r.guardado.id).catch((e: unknown) =>
        console.error('[api] envío inmediato falló, queda en cola:', e instanceof Error ? e.message : e),
      );
    }
    // Pago ya confirmado (ej. Yape): se registra por el saldo. Repetir el pedido no lo duplica
    // (la referencia de la operación es única) ni falla si ya estaba pagado.
    let errorPago: string | undefined;
    if (leido.valor.pago && r.guardado.comprobante.tipo !== '07' && !(await estadoCobro(dep.db, r.guardado.id)).saldo.isZero()) {
      const pago = await registrarPago(dep.db, { empresaId: quien.empresaId, comprobanteId: r.guardado.id, ...autor, ...leido.valor.pago });
      if (pago.resultado === 'ERROR') errorPago = pago.errores.join(' ');
    }
    return c.json(
      { ...(await respuestaComprobante(c, r.guardado.id)), repetido: r.resultado === 'REPETIDO', ...(errorPago ? { errorPago } : {}) },
      r.resultado === 'EMITIDO' ? 201 : 200,
    );
  }

  app.post('/v1/comprobantes', async (c) => {
    const sinPermiso = requiere(c, 'emitir');
    if (sinPermiso) return sinPermiso;
    const llave = c.get('llave');
    const cuerpo = await c.req.json().catch(() => undefined);
    return emitirYResponder(c, { empresaId: llave.empresaId, canalId: llave.canalId, apiLlaveId: llave.apiLlaveId }, cuerpo, llave.permisos.includes('cobrar'));
  });

  app.post('/v1/comprobantes/:id/pagos', async (c) => {
    const sinPermiso = requiere(c, 'cobrar');
    if (sinPermiso) return sinPermiso;
    const id = await comprobanteDeLaLlave(c);
    if (!id) return error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const cuerpo = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof cuerpo.monto === 'number') return error(c, 422, 'DATOS_INVALIDOS', 'Envía el monto como texto, por ejemplo "350.00".');
    const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const medio = texto(cuerpo.medio)?.toUpperCase() as MedioPago | undefined;
    if (!medio || !MEDIOS_PAGO.includes(medio)) return error(c, 422, 'DATOS_INVALIDOS', `medio: usa ${MEDIOS_PAGO.join(', ')}.`);
    const llave = c.get('llave');
    const monto = texto(cuerpo.monto);
    const referencia = texto(cuerpo.referencia);
    const fecha = texto(cuerpo.fecha);
    const r = await registrarPago(dep.db, {
      empresaId: llave.empresaId, comprobanteId: id, medio, apiLlaveId: llave.apiLlaveId,
      ...(monto ? { monto } : {}), ...(referencia ? { referencia } : {}), ...(fecha ? { fecha } : {}),
    });
    if (r.resultado === 'ERROR') return error(c, 422, 'PAGO_INVALIDO', r.errores[0] ?? 'Pago inválido.', r.errores);
    return c.json(
      { pagoId: r.pagoId, repetido: r.resultado === 'REPETIDO', estadoPago: r.cobro.estadoPago, saldo: r.cobro.saldo.toFixed(2), pagado: r.cobro.pagado.toFixed(2) },
      r.resultado === 'REGISTRADO' ? 201 : 200,
    );
  });

  app.get('/v1/reportes/resumen-dia', async (c) => {
    const sinPermiso = requiere(c, 'consultar');
    if (sinPermiso) return sinPermiso;
    const fecha = c.req.query('fecha');
    if (fecha !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return error(c, 400, 'FECHA_INVALIDA', 'fecha: usa AAAA-MM-DD.');
    return c.json(await resumenDelDia(dep.db, c.get('llave').empresaId, fecha));
  });

  app.get('/v1/comprobantes', async (c) => {
    const sinPermiso = requiere(c, 'consultar');
    if (sinPermiso) return sinPermiso;
    const pedido = c.req.query('pedido');
    if (!pedido) return error(c, 400, 'FALTA_PEDIDO', 'Indica ?pedido=<número de pedido>.');
    // Un pedido puede tener un comprobante RECHAZADO y el nuevo que lo reemplazó: manda el vigente.
    const r = await dep.db.query(`SELECT id FROM comprobantes WHERE empresa_id = $1 AND canal_id = $2 AND pedido_externo_id = $3
      ORDER BY estado = 'RECHAZADO', creado_en DESC LIMIT 1`, [
      c.get('llave').empresaId, c.get('llave').canalId, pedido,
    ]);
    if (!r.rows[0]) return error(c, 404, 'NO_ENCONTRADO', 'No hay comprobante para ese pedido.');
    return c.json(await respuestaComprobante(c, r.rows[0].id));
  });

  app.get('/v1/comprobantes/:id', async (c) => {
    const sinPermiso = requiere(c, 'consultar');
    if (sinPermiso) return sinPermiso;
    const id = await comprobanteDeLaLlave(c);
    if (!id) return error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    return c.json(await respuestaComprobante(c, id));
  });

  app.get('/v1/comprobantes/:id/pdf', async (c) => {
    const sinPermiso = requiere(c, 'consultar');
    if (sinPermiso) return sinPermiso;
    const id = await comprobanteDeLaLlave(c);
    if (!id) return error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const formato = c.req.query('formato');
    if (formato !== undefined && !esFormatoPdf(formato)) return error(c, 400, 'FORMATO_INVALIDO', 'formato debe ser A4 o TICKET_80.');
    try {
      const r = await pdfDeComprobante(dep.db, id, { almacen: dep.servicios.almacen, ...(formato ? { formato } : {}) });
      return c.body(new Uint8Array(r.pdf), 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.nombreArchivo}"` });
    } catch (e) {
      if (e instanceof ErrorPdf) return error(c, 409, 'PDF_NO_DISPONIBLE', e.message);
      throw e;
    }
  });

  for (const tipo of ['xml', 'cdr'] as const) {
    app.get(`/v1/comprobantes/:id/${tipo}`, async (c) => {
      const sinPermiso = requiere(c, 'consultar');
      if (sinPermiso) return sinPermiso;
      const id = await comprobanteDeLaLlave(c);
      if (!id) return error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
      const a = await dep.db.query(
        `SELECT ruta_almacenamiento FROM archivos WHERE entidad = 'comprobantes' AND entidad_id = $1 AND tipo = $2 ORDER BY creado_en DESC LIMIT 1`,
        [id, tipo === 'xml' ? 'XML_FIRMADO' : 'CDR'],
      );
      const ruta = a.rows[0]?.ruta_almacenamiento as string | undefined;
      if (!ruta) return error(c, 409, 'ARCHIVO_NO_DISPONIBLE', tipo === 'xml' ? 'El comprobante aún no está firmado.' : 'SUNAT aún no respondió.');
      const contenido = await dep.servicios.almacen.leer(ruta);
      const nombre = ruta.split('/').at(-1)!;
      return c.body(new Uint8Array(contenido), 200, {
        'Content-Type': tipo === 'xml' ? 'application/xml' : 'application/zip',
        'Content-Disposition': `attachment; filename="${nombre}"`,
      });
    });
  }

  app.post('/v1/comprobantes/:id/anular', async (c) => {
    const sinPermiso = requiere(c, 'anular');
    if (sinPermiso) return sinPermiso;
    const id = await comprobanteDeLaLlave(c);
    if (!id) return error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const cuerpo = (await c.req.json().catch(() => ({}))) as { motivo?: unknown };
    const r = await solicitarAnulacion(dep.db, { comprobanteId: id, motivo: typeof cuerpo.motivo === 'string' ? cuerpo.motivo : '' });
    if (r.resultado === 'ERROR') return error(c, 422, 'NO_SE_PUEDE_ANULAR', r.errores[0] ?? 'No se pudo anular.', r.errores);
    return c.json({ estado: 'ANULACION_EN_PROCESO', via: r.via, documento: r.identificador }, 202);
  });

  // Panel web (/panel): usuarios con contraseña + código de 6 dígitos, no llaves de canal.
  registrarPanel(app, {
    db: dep.db, llaveMaestra: dep.servicios.llaveMaestra, almacen: dep.servicios.almacen, error, ipCliente, fallos,
    emitir: (c, quien, cuerpo) => emitirYResponder(c, quien, cuerpo, true),
    respuestaComprobante,
    // Sin clave de instalación (o muy corta), la primera configuración pide la llave de la tienda.
    claveInstalacionValida: (clave) =>
      Boolean(dep.claveInstalacion && dep.claveInstalacion.length >= 16 && igualesEnTiempoConstante(clave, dep.claveInstalacion)),
    // Clave puesta en Render pero con menos de 16 caracteres: se ignora, y el panel lo explica.
    recuperacionMuyCorta: Boolean(dep.claveRecuperacion && dep.claveRecuperacion.length < 16),
    instalacionMuyCorta: Boolean(dep.claveInstalacion && dep.claveInstalacion.length < 16),
    ...(dep.correo ? { correo: dep.correo } : {}),
    claveRecuperacionValida: (clave) =>
      Boolean(dep.claveRecuperacion && dep.claveRecuperacion.length >= 16 && igualesEnTiempoConstante(clave, dep.claveRecuperacion)),
  });

  return app;
}
