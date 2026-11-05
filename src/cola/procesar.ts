/**
 * Procesador de la cola de envíos a SUNAT.
 *
 * Se ejecuta cada minuto (cron). En cada vuelta:
 *   1. Toma los trabajos vencidos de uno en uno (FOR UPDATE SKIP LOCKED: dos
 *      procesadores nunca toman el mismo trabajo).
 *   2. Los procesa SIN mantener abierta una transacción durante la llamada a SUNAT.
 *   3. Guarda el resultado y reprograma o cierra el trabajo.
 *
 * Reglas:
 *   - Falla temporal (sin respuesta, timeout, error 0100…): el comprobante queda
 *     PENDIENTE_ENVIO y se reintenta solo, con espera creciente. NUNCA se descarta.
 *   - Rechazo de SUNAT: el comprobante queda RECHAZADO y se crea una alerta roja.
 *   - Problema de configuración (usuario SOL, certificado…): el trabajo queda
 *     FALLIDO_REVISAR con una alerta; se reactiva al corregirlo.
 */
import { createHash } from 'node:crypto';
import { crearAlerta } from '../alertas.js';
import { recalcularCobro } from '../cobros/pagos.js';
import { revertirStockDe } from '../inventario/stock.js';
import { firmarComprobante, type ServiciosFirma } from '../comprobantes/firmar-comprobante.js';
import { cargarComprobante, cargarEmpresa } from '../comprobantes/repositorio.js';
import { enTransaccion, type Db, type Tx } from '../db/conexion.js';
import { ErrorCertificado } from '../firma/certificado.js';
import { firmarXml } from '../firma/firmar.js';
import { obtenerCertificadoActivo } from '../firma/repositorio-certificados.js';
import type { Cdr } from '../sunat/cdr.js';
import { ErrorConexionSunat, ErrorRespuestaSunat, type ClienteSunat, type CredencialesSunat } from '../sunat/cliente.js';
import { ErrorConfiguracionSunat, credencialesSunat, urlServicio, type Ambiente } from '../sunat/configuracion.js';
import { CODIGOS_YA_REGISTRADO, explicarCodigo } from '../sunat/errores.js';
import { idComprobanteLegible, type Empresa } from '../tipos.js';
import { CondicionResumen } from '../catalogos.js';
import { ahoraLima } from '../fechas.js';
import { nombreArchivoComprobante, nombreArchivoResumen } from '../xml/nombres.js';
import { generarXmlComunicacionBaja, generarXmlResumenDiario, idResumen } from '../xml/resumenes.js';

export interface ServiciosEnvio extends ServiciosFirma {
  crearCliente(url: string, credenciales: CredencialesSunat): ClienteSunat;
  entorno?: NodeJS.ProcessEnv;
}

/** Minutos de espera antes de cada reintento (después se repite el último). */
export const ESPERAS_MINUTOS = [1, 2, 5, 10, 30, 60, 120, 240];
/** A partir de este intento fallido se avisa al dueño. */
const INTENTOS_PARA_ALERTA = 5;

interface Trabajo {
  id: string;
  empresa_id: string;
  tipo: 'COMPROBANTE' | 'RESUMEN_DIARIO' | 'BAJA' | 'CONSULTA_TICKET' | 'CONSULTA_ESTADO';
  referencia_id: string;
  intentos: number;
  fecha_limite_legal: string | null;
}

type Desenlace =
  | { tipo: 'HECHO' }
  | { tipo: 'REINTENTAR'; error: string; esperaMinutos?: number }
  | { tipo: 'REVISAR'; error: string };

export interface ResumenVuelta {
  procesados: number;
  hechos: number;
  reintentos: number;
  revisar: number;
}

export async function procesarCola(db: Db, s: ServiciosEnvio, limite = 20): Promise<ResumenVuelta> {
  const resumen: ResumenVuelta = { procesados: 0, hechos: 0, reintentos: 0, revisar: 0 };
  // Se toma UN trabajo a la vez: su bloqueo de 5 minutos cubre de sobra un envío
  // (máximo ~45 s de espera a SUNAT). Si se tomaran varios juntos, los últimos podrían
  // quedar con el bloqueo vencido y otro procesador los enviaría de nuevo (duplicado).
  for (let i = 0; i < limite; i++) {
    const d = await tomarYProcesar(db, s);
    if (!d) break;
    resumen.procesados++;
    if (d.tipo === 'HECHO') resumen.hechos++;
    else if (d.tipo === 'REINTENTAR') resumen.reintentos++;
    else resumen.revisar++;
  }
  return resumen;
}

/**
 * Envía YA el trabajo pendiente de un comprobante (lo usa la API al emitir, para no
 * esperar a la siguiente vuelta del cron). Si otro procesador lo tiene tomado, no hace nada.
 * Devuelve true si lo procesó.
 */
export async function procesarAhora(db: Db, s: ServiciosEnvio, referenciaId: string): Promise<boolean> {
  return (await tomarYProcesar(db, s, referenciaId)) !== undefined;
}

async function tomarYProcesar(db: Db, s: ServiciosEnvio, referenciaId?: string): Promise<Desenlace | undefined> {
  const ahora = s.ahora?.() ?? new Date();
  const tomado = await db.query<Trabajo>(
    `UPDATE cola_envios SET estado = 'PROCESANDO', intentos = intentos + 1,
            bloqueado_hasta = $1::timestamptz + interval '5 minutes', actualizado_en = $1
     WHERE id = (
       SELECT id FROM cola_envios
       WHERE ((estado = 'PENDIENTE' AND proximo_intento_en <= $1)
          OR (estado = 'PROCESANDO' AND bloqueado_hasta < $1))   -- un procesador que se cayó
         AND ($2::uuid IS NULL OR referencia_id = $2::uuid)
       ORDER BY proximo_intento_en LIMIT 1
       FOR UPDATE SKIP LOCKED)
     RETURNING id, empresa_id, tipo, referencia_id, intentos, to_char(fecha_limite_legal, 'YYYY-MM-DD') AS fecha_limite_legal`,
    [ahora, referenciaId ?? null],
  );
  const t = tomado.rows[0];
  if (!t) return undefined;
  let d: Desenlace;
  try {
    d = await procesarTrabajo(db, s, t);
  } catch (e) {
    // Algo inesperado: no se pierde, queda para reintentar y se registra el error.
    d = { tipo: 'REINTENTAR', error: `Error interno: ${e instanceof Error ? e.message : String(e)}` };
  }
  await cerrarTrabajo(db, t, d, ahora);
  return d;
}

async function procesarTrabajo(db: Db, s: ServiciosEnvio, t: Trabajo): Promise<Desenlace> {
  switch (t.tipo) {
    case 'COMPROBANTE':
      return enviarComprobante(db, s, t);
    case 'RESUMEN_DIARIO':
    case 'BAJA':
      return enviarResumen(db, s, t);
    case 'CONSULTA_TICKET':
      return consultarTicket(db, s, t);
    default:
      return { tipo: 'REVISAR', error: `Tipo de trabajo aún no soportado: ${t.tipo}` };
  }
}

async function cerrarTrabajo(db: Db, t: Trabajo, d: Desenlace, ahora: Date): Promise<void> {
  if (d.tipo === 'HECHO') {
    await db.query(`UPDATE cola_envios SET estado = 'HECHO', bloqueado_hasta = NULL, ultimo_error = NULL, actualizado_en = $2 WHERE id = $1`, [t.id, ahora]);
    return;
  }
  if (d.tipo === 'REVISAR') {
    await db.query(`UPDATE cola_envios SET estado = 'FALLIDO_REVISAR', bloqueado_hasta = NULL, ultimo_error = $2, actualizado_en = $3 WHERE id = $1`, [t.id, d.error, ahora]);
    await crearAlerta(db, { empresaId: t.empresa_id, tipo: 'ENVIO_REQUIERE_REVISION', severidad: 'ROJO', mensaje: d.error, entidad: 'cola_envios', entidadId: t.id });
    return;
  }
  const espera = d.esperaMinutos ?? ESPERAS_MINUTOS[Math.min(t.intentos - 1, ESPERAS_MINUTOS.length - 1)]!;
  await db.query(
    `UPDATE cola_envios SET estado = 'PENDIENTE', bloqueado_hasta = NULL, ultimo_error = $2,
            proximo_intento_en = $3::timestamptz + make_interval(mins => $4), actualizado_en = $3 WHERE id = $1`,
    [t.id, d.error, ahora, espera],
  );
  if (t.intentos >= INTENTOS_PARA_ALERTA) {
    await crearAlerta(db, {
      empresaId: t.empresa_id, tipo: 'SUNAT_SIN_RESPUESTA', severidad: 'AMARILLO',
      mensaje: `Van ${t.intentos} intentos sin poder enviar a SUNAT. Se sigue reintentando solo. Último error: ${d.error}`,
      entidad: 'cola_envios', entidadId: t.id,
    });
  }
  // Fechas legales en hora de Lima: se avisa cuando falta un día o menos.
  const hoy = ahoraLima(ahora).fecha;
  if (t.fecha_limite_legal && t.fecha_limite_legal <= ahoraLima(new Date(ahora.getTime() + 86_400_000)).fecha) {
    await crearAlerta(db, {
      empresaId: t.empresa_id, tipo: 'PLAZO_LEGAL_CERCANO', severidad: 'ROJO',
      mensaje: `El plazo legal para enviar a SUNAT vence el ${t.fecha_limite_legal} (hoy es ${hoy}) y aún no se pudo enviar.`,
      entidad: 'cola_envios', entidadId: t.id,
    });
  }
}

/** Registra cada intento (éxito o error) para el historial. */
async function registrarEnvio(
  q: Db | Tx,
  e: { empresaId: string; tipo: Trabajo['tipo']; referenciaId: string; metodo: string; ambiente: Ambiente; inicio: number; codigo?: string; mensaje?: string; ticket?: string; http?: number; resultado: string },
): Promise<void> {
  await q.query(
    `INSERT INTO envios_sunat (empresa_id, tipo, referencia_id, metodo, ambiente, ticket, http_estado, codigo_respuesta, mensaje, duracion_ms, resultado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.empresaId, e.tipo, e.referenciaId, e.metodo, e.ambiente, e.ticket ?? null, e.http ?? null, e.codigo ?? null, e.mensaje ?? null, Date.now() - e.inicio, e.resultado],
  );
}

/** Guarda el ZIP del CDR (constancia de SUNAT) en el almacén y en `archivos`. */
async function guardarCdr(tx: Tx, s: ServiciosEnvio, empresaId: string, entidad: string, entidadId: string, ruc: string, nombre: string, cdr: Cdr): Promise<void> {
  const sha256 = createHash('sha256').update(cdr.zip).digest('hex');
  const ruta = `${ruc}/cdr/R-${nombre}-${sha256.slice(0, 12)}.zip`;
  await s.almacen.guardar(ruta, cdr.zip, tx);
  await tx.query(
    `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
     VALUES ($1, $2, $3, 'CDR', $4, $5, $6, (current_date + interval '6 years')::date)`,
    [empresaId, entidad, entidadId, ruta, sha256, cdr.zip.length],
  );
}

/** Convierte un error de la llamada a SUNAT en el desenlace que corresponde. */
async function clasificarError(db: Db, e: unknown): Promise<{ desenlace: Desenlace; codigo?: string; http?: number; mensaje: string; esRechazo: boolean }> {
  if (e instanceof ErrorConexionSunat) {
    return { desenlace: { tipo: 'REINTENTAR', error: e.message }, mensaje: e.message, esRechazo: false, ...(e.httpEstado ? { http: e.httpEstado } : {}) };
  }
  if (e instanceof ErrorRespuestaSunat) {
    const x = await explicarCodigo(db, e.codigo, e.mensajeSunat);
    if (x.reintentable) return { desenlace: { tipo: 'REINTENTAR', error: x.mensaje }, codigo: e.codigo, http: e.httpEstado, mensaje: x.mensaje, esRechazo: false };
    if (CODIGOS_YA_REGISTRADO.has(e.codigo)) {
      const msg = `${x.mensaje} (No se reenvía automáticamente para no duplicar.)`;
      return { desenlace: { tipo: 'REVISAR', error: msg }, codigo: e.codigo, http: e.httpEstado, mensaje: msg, esRechazo: false };
    }
    if (x.tipo === 'RECHAZO') return { desenlace: { tipo: 'HECHO' }, codigo: e.codigo, http: e.httpEstado, mensaje: x.mensaje, esRechazo: true };
    return { desenlace: { tipo: 'REVISAR', error: x.mensaje }, codigo: e.codigo, http: e.httpEstado, mensaje: x.mensaje, esRechazo: false };
  }
  if (e instanceof ErrorConfiguracionSunat || e instanceof ErrorCertificado) {
    return { desenlace: { tipo: 'REVISAR', error: e.message }, mensaje: e.message, esRechazo: false };
  }
  throw e;
}

async function prepararConexion(db: Db, s: ServiciosEnvio, empresaId: string, ruc: string, ambiente: Ambiente): Promise<ClienteSunat> {
  const url = urlServicio(ambiente, s.entorno ?? process.env);
  const cred = await credencialesSunat(db, empresaId, ruc, ambiente, s.llaveMaestra);
  return s.crearCliente(url, cred);
}

// ---------------------------------------------------------------------------
// Comprobantes (factura, boleta, nota de crédito) → sendBill
// ---------------------------------------------------------------------------

async function enviarComprobante(db: Db, s: ServiciosEnvio, t: Trabajo): Promise<Desenlace> {
  const id = t.referencia_id;
  const estadoActual = await db.query(`SELECT estado, ambiente_sunat FROM comprobantes WHERE id = $1`, [id]);
  const fila = estadoActual.rows[0];
  if (!fila) return { tipo: 'REVISAR', error: 'El comprobante del trabajo no existe.' };
  if (!['EMITIDO_LOCAL', 'PENDIENTE_ENVIO'].includes(fila.estado)) return { tipo: 'HECHO' }; // ya resuelto antes
  const ambiente = fila.ambiente_sunat as Ambiente;

  let firmado;
  try {
    firmado = await firmarComprobante(db, s, id);
  } catch (e) {
    if (e instanceof ErrorCertificado) return { tipo: 'REVISAR', error: e.message };
    throw e;
  }
  const { comprobante: c } = await cargarComprobante(db, id);
  const nombre = nombreArchivoComprobante(c.empresa.ruc, c.tipo, c.serie, c.numero);
  const legible = idComprobanteLegible(c.serie, c.numero);
  const inicio = Date.now();

  let cdr: Cdr;
  try {
    const cliente = await prepararConexion(db, s, t.empresa_id, c.empresa.ruc, ambiente);
    cdr = await cliente.sendBill(nombre, firmado.xmlFirmado);
  } catch (e) {
    const x = await clasificarError(db, e);
    await enTransaccion(db, async (tx) => {
      await registrarEnvio(tx, {
        empresaId: t.empresa_id, tipo: t.tipo, referenciaId: id, metodo: 'sendBill', ambiente, inicio,
        resultado: x.esRechazo ? 'RECHAZADO' : x.desenlace.tipo, mensaje: x.mensaje,
        ...(x.codigo ? { codigo: x.codigo } : {}), ...(x.http ? { http: x.http } : {}),
      });
      if (x.esRechazo) {
        await cambiarEstado(tx, id, 'RECHAZADO', x.mensaje, { codigo: x.codigo ?? '', mensaje: x.mensaje });
        await crearAlerta(tx, { empresaId: t.empresa_id, tipo: 'COMPROBANTE_RECHAZADO', severidad: 'ROJO', mensaje: `SUNAT rechazó ${legible}. ${x.mensaje}`, entidad: 'comprobantes', entidadId: id });
      } else if (fila.estado === 'EMITIDO_LOCAL') {
        await cambiarEstado(tx, id, 'PENDIENTE_ENVIO', `No se pudo enviar a SUNAT: ${x.mensaje}`);
      }
    });
    return x.desenlace;
  }

  await enTransaccion(db, async (tx) => {
    await registrarEnvio(tx, {
      empresaId: t.empresa_id, tipo: t.tipo, referenciaId: id, metodo: 'sendBill', ambiente, inicio,
      codigo: cdr.codigo, mensaje: cdr.descripcion, resultado: cdr.resultado,
    });
    await guardarCdr(tx, s, t.empresa_id, 'comprobantes', id, c.empresa.ruc, nombre, cdr);
    let mensaje = cdr.descripcion;
    if (cdr.resultado === 'RECHAZADO') {
      mensaje = (await explicarCodigo(tx, cdr.codigo, cdr.descripcion)).mensaje;
      await crearAlerta(tx, { empresaId: t.empresa_id, tipo: 'COMPROBANTE_RECHAZADO', severidad: 'ROJO', mensaje: `SUNAT rechazó ${legible}. ${mensaje}`, entidad: 'comprobantes', entidadId: id });
    } else if (cdr.resultado === 'ACEPTADO_OBS') {
      await crearAlerta(tx, { empresaId: t.empresa_id, tipo: 'COMPROBANTE_CON_OBSERVACIONES', severidad: 'AMARILLO', mensaje: `${legible} fue aceptado con observaciones: ${cdr.observaciones.join(' | ')}`, entidad: 'comprobantes', entidadId: id });
    }
    await cambiarEstado(tx, id, cdr.resultado, `SUNAT: ${mensaje}`, { codigo: cdr.codigo, mensaje, observaciones: cdr.observaciones });
  });
  return { tipo: 'HECHO' };
}

async function cambiarEstado(
  tx: Tx,
  comprobanteId: string,
  nuevo: string,
  detalle: string,
  sunat?: { codigo: string; mensaje: string; observaciones?: string[] },
): Promise<void> {
  const r = await tx.query(
    `UPDATE comprobantes c SET estado = $2::estado_comprobante,
        sunat_codigo_respuesta = coalesce($3, c.sunat_codigo_respuesta),
        sunat_mensaje = coalesce($4, c.sunat_mensaje),
        sunat_observaciones = coalesce($5::jsonb, c.sunat_observaciones),
        enviado_en = coalesce(c.enviado_en, now()),
        respondido_en = CASE WHEN $3::text IS NULL THEN c.respondido_en ELSE now() END
     FROM (SELECT estado FROM comprobantes WHERE id = $1 FOR UPDATE) anterior
     WHERE c.id = $1 RETURNING anterior.estado AS anterior, c.comprobante_referencia_id AS referencia`,
    [comprobanteId, nuevo, sunat?.codigo ?? null, sunat?.mensaje ?? null, sunat?.observaciones?.length ? JSON.stringify(sunat.observaciones) : null],
  );
  await tx.query(
    `INSERT INTO comprobante_eventos (comprobante_id, estado_anterior, estado_nuevo, detalle) VALUES ($1, $2, $3, $4)`,
    [comprobanteId, r.rows[0]?.anterior ?? null, nuevo, detalle],
  );
  // Rechazado o anulado: lo que movió en el stock (venta, devolución) se revierte.
  if (nuevo === 'RECHAZADO' || nuevo === 'ANULADO') await revertirStockDe(tx, comprobanteId);
  // Si es una nota de crédito, su estado cambia el saldo del comprobante que modifica.
  if (r.rows[0]?.referencia) await recalcularCobro(tx, r.rows[0].referencia as string);
}

// ---------------------------------------------------------------------------
// Resumen diario (anulación de boletas) y comunicación de baja → sendSummary
// ---------------------------------------------------------------------------

interface DocumentoResumen {
  tabla: 'resumenes_diarios' | 'comunicaciones_baja';
  prefijo: 'RC' | 'RA';
  id: string;
  empresaId: string;
  fechaGeneracion: string;
  fechaReferencia: string;
  correlativo: number;
  ticket: string | null;
  estado: string;
  ambiente: Ambiente;
  comprobantes: { id: string; motivo: string | null; condicion: string | null }[];
}

async function cargarDocumentoResumen(q: Db | Tx, id: string): Promise<DocumentoResumen | undefined> {
  for (const [tabla, prefijo, items, fk] of [
    ['resumenes_diarios', 'RC', 'resumen_items', 'resumen_id'],
    ['comunicaciones_baja', 'RA', 'baja_items', 'baja_id'],
  ] as const) {
    const r = await q.query(
      `SELECT id, empresa_id, correlativo, ticket, estado, ambiente_sunat,
              to_char(fecha_generacion, 'YYYY-MM-DD') AS fg, to_char(fecha_referencia, 'YYYY-MM-DD') AS fr
       FROM ${tabla} WHERE id = $1`,
      [id],
    );
    const d = r.rows[0];
    if (!d) continue;
    const it = await q.query(
      `SELECT comprobante_id, ${tabla === 'comunicaciones_baja' ? 'motivo' : 'NULL AS motivo'}, ${tabla === 'resumenes_diarios' ? 'condicion' : 'NULL AS condicion'}
       FROM ${items} WHERE ${fk} = $1 ORDER BY linea`,
      [id],
    );
    return {
      tabla, prefijo, id: d.id, empresaId: d.empresa_id, fechaGeneracion: d.fg, fechaReferencia: d.fr,
      correlativo: Number(d.correlativo), ticket: d.ticket, estado: d.estado, ambiente: d.ambiente_sunat,
      comprobantes: it.rows.map((x) => ({ id: x.comprobante_id, motivo: x.motivo, condicion: x.condicion })),
    };
  }
  return undefined;
}

/** Firma el RC/RA una sola vez y reutiliza el mismo XML en cada reintento. */
async function xmlFirmadoResumen(db: Db, s: ServiciosEnvio, d: DocumentoResumen, empresa: Empresa): Promise<string> {
  return enTransaccion(db, async (tx) => {
    await tx.query(`SELECT 1 FROM ${d.tabla} WHERE id = $1 FOR UPDATE`, [d.id]);
    const ya = await tx.query(`SELECT ruta_almacenamiento, sha256 FROM archivos WHERE entidad = $1 AND entidad_id = $2 AND tipo = 'XML_FIRMADO'`, [d.tabla, d.id]);
    if (ya.rows[0]) {
      const contenido = await s.almacen.leer(ya.rows[0].ruta_almacenamiento, tx);
      if (createHash('sha256').update(contenido).digest('hex') !== ya.rows[0].sha256) throw new Error('El XML firmado del resumen fue alterado.');
      return contenido.toString('utf8');
    }
    let xml: string;
    if (d.prefijo === 'RA') {
      const lineas = [];
      for (const it of d.comprobantes) {
        const { comprobante: c } = await cargarComprobante(tx, it.id);
        lineas.push({ tipo: c.tipo, serie: c.serie, numero: c.numero, motivo: it.motivo ?? '' });
      }
      xml = generarXmlComunicacionBaja({ empresa, correlativo: d.correlativo, fechaReferencia: d.fechaReferencia, fechaGeneracion: d.fechaGeneracion, lineas });
    } else {
      const lineas = [];
      for (const it of d.comprobantes) {
        const { comprobante } = await cargarComprobante(tx, it.id);
        lineas.push({ comprobante, condicion: (it.condicion ?? CondicionResumen.ANULAR) as CondicionResumen });
      }
      xml = generarXmlResumenDiario({ empresa, correlativo: d.correlativo, fechaReferencia: d.fechaReferencia, fechaGeneracion: d.fechaGeneracion, lineas });
    }
    const { certificado } = await obtenerCertificadoActivo(tx, d.empresaId, s.llaveMaestra, s.ahora?.() ?? new Date());
    const firma = firmarXml(xml, certificado, s.algoritmo);
    const contenido = Buffer.from(firma.xmlFirmado, 'utf8');
    const sha256 = createHash('sha256').update(contenido).digest('hex');
    const nombre = nombreArchivoResumen(empresa.ruc, idResumen(d.prefijo, d.fechaGeneracion, d.correlativo));
    const ruta = `${empresa.ruc}/${d.fechaGeneracion.slice(0, 4)}/${d.fechaGeneracion.slice(5, 7)}/${nombre}-${sha256.slice(0, 12)}.xml`;
    await s.almacen.guardar(ruta, contenido, tx);
    await tx.query(
      `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
       VALUES ($1, $2, $3, 'XML_FIRMADO', $4, $5, $6, (current_date + interval '6 years')::date)`,
      [d.empresaId, d.tabla, d.id, ruta, sha256, contenido.length],
    );
    await tx.query(`UPDATE ${d.tabla} SET hash_firma = $2 WHERE id = $1`, [d.id, firma.digestValue]);
    return firma.xmlFirmado;
  });
}

async function enviarResumen(db: Db, s: ServiciosEnvio, t: Trabajo): Promise<Desenlace> {
  const d = await cargarDocumentoResumen(db, t.referencia_id);
  if (!d) return { tipo: 'REVISAR', error: 'El resumen o la baja del trabajo no existe.' };
  if (d.estado !== 'GENERADO') return { tipo: 'HECHO' };
  const { empresa } = await cargarEmpresa(db, d.empresaId, d.fechaGeneracion);
  const nombre = nombreArchivoResumen(empresa.ruc, idResumen(d.prefijo, d.fechaGeneracion, d.correlativo));
  const inicio = Date.now();

  let ticket: string;
  try {
    const xml = await xmlFirmadoResumen(db, s, d, empresa);
    const cliente = await prepararConexion(db, s, d.empresaId, empresa.ruc, d.ambiente);
    ticket = await cliente.sendSummary(nombre, xml);
  } catch (e) {
    const x = await clasificarError(db, e);
    await enTransaccion(db, async (tx) => {
      await registrarEnvio(tx, {
        empresaId: d.empresaId, tipo: t.tipo, referenciaId: d.id, metodo: 'sendSummary', ambiente: d.ambiente, inicio,
        resultado: x.esRechazo ? 'RECHAZADO' : x.desenlace.tipo, mensaje: x.mensaje,
        ...(x.codigo ? { codigo: x.codigo } : {}), ...(x.http ? { http: x.http } : {}),
      });
      if (x.esRechazo) await anulacionRechazada(tx, d, x.codigo ?? '', x.mensaje);
    });
    return x.desenlace;
  }

  await enTransaccion(db, async (tx) => {
    await registrarEnvio(tx, { empresaId: d.empresaId, tipo: t.tipo, referenciaId: d.id, metodo: 'sendSummary', ambiente: d.ambiente, inicio, ticket, resultado: 'TICKET' });
    await tx.query(`UPDATE ${d.tabla} SET estado = 'ENVIADO', ticket = $2 WHERE id = $1`, [d.id, ticket]);
    // SUNAT procesa los resúmenes en segundo plano: se consulta el ticket en un minuto.
    await tx.query(
      `INSERT INTO cola_envios (empresa_id, tipo, referencia_id, proximo_intento_en, fecha_limite_legal)
       VALUES ($1, 'CONSULTA_TICKET', $2, $3::timestamptz + interval '1 minute', $4)`,
      [d.empresaId, d.id, s.ahora?.() ?? new Date(), t.fecha_limite_legal],
    );
  });
  return { tipo: 'HECHO' };
}

async function consultarTicket(db: Db, s: ServiciosEnvio, t: Trabajo): Promise<Desenlace> {
  const d = await cargarDocumentoResumen(db, t.referencia_id);
  if (!d || !d.ticket) return { tipo: 'REVISAR', error: 'No se encontró el ticket a consultar.' };
  if (d.estado === 'ACEPTADO' || d.estado === 'RECHAZADO') return { tipo: 'HECHO' };
  const { empresa } = await cargarEmpresa(db, d.empresaId, d.fechaGeneracion);
  const nombre = nombreArchivoResumen(empresa.ruc, idResumen(d.prefijo, d.fechaGeneracion, d.correlativo));
  const inicio = Date.now();

  let estado;
  try {
    const cliente = await prepararConexion(db, s, d.empresaId, empresa.ruc, d.ambiente);
    estado = await cliente.getStatus(d.ticket);
  } catch (e) {
    const x = await clasificarError(db, e);
    await registrarEnvio(db, {
      empresaId: d.empresaId, tipo: t.tipo, referenciaId: d.id, metodo: 'getStatus', ambiente: d.ambiente, inicio, ticket: d.ticket,
      resultado: x.desenlace.tipo, mensaje: x.mensaje, ...(x.codigo ? { codigo: x.codigo } : {}),
    });
    // Un error al consultar no significa que el resumen fue rechazado: se vuelve a consultar.
    return x.desenlace.tipo === 'HECHO' ? { tipo: 'REVISAR', error: x.mensaje } : x.desenlace;
  }

  if (estado.statusCode === '98') {
    await db.query(`UPDATE ${d.tabla} SET estado = 'EN_PROCESO' WHERE id = $1`, [d.id]);
    await registrarEnvio(db, { empresaId: d.empresaId, tipo: t.tipo, referenciaId: d.id, metodo: 'getStatus', ambiente: d.ambiente, inicio, ticket: d.ticket, codigo: '98', resultado: 'EN_PROCESO' });
    return { tipo: 'REINTENTAR', error: 'SUNAT aún está procesando el resumen.', esperaMinutos: 2 };
  }
  const cdr = estado.cdr;
  if (!cdr) return { tipo: 'REINTENTAR', error: `SUNAT respondió estado ${estado.statusCode} sin constancia.` };

  await enTransaccion(db, async (tx) => {
    await registrarEnvio(tx, { empresaId: d.empresaId, tipo: t.tipo, referenciaId: d.id, metodo: 'getStatus', ambiente: d.ambiente, inicio, ticket: d.ticket!, codigo: cdr.codigo, mensaje: cdr.descripcion, resultado: cdr.resultado });
    await guardarCdr(tx, s, d.empresaId, d.tabla, d.id, empresa.ruc, nombre, cdr);
    if (cdr.resultado === 'RECHAZADO') {
      await anulacionRechazada(tx, d, cdr.codigo, (await explicarCodigo(tx, cdr.codigo, cdr.descripcion)).mensaje);
      return;
    }
    await tx.query(`UPDATE ${d.tabla} SET estado = 'ACEPTADO', sunat_codigo = $2, sunat_mensaje = $3 WHERE id = $1`, [d.id, cdr.codigo, cdr.descripcion]);
    for (const it of d.comprobantes) {
      await cambiarEstado(tx, it.id, 'ANULADO', `Anulación aceptada por SUNAT (${idResumen(d.prefijo, d.fechaGeneracion, d.correlativo)})`, { codigo: cdr.codigo, mensaje: cdr.descripcion });
    }
  });
  return { tipo: 'HECHO' };
}

/** SUNAT rechazó la anulación: el comprobante vuelve a su estado anterior (sigue vigente). */
async function anulacionRechazada(tx: Tx, d: DocumentoResumen, codigo: string, mensaje: string): Promise<void> {
  await tx.query(`UPDATE ${d.tabla} SET estado = 'RECHAZADO', sunat_codigo = $2, sunat_mensaje = $3 WHERE id = $1`, [d.id, codigo, mensaje]);
  for (const it of d.comprobantes) {
    const r = await tx.query(`SELECT estado_antes_de_anular FROM comprobantes WHERE id = $1`, [it.id]);
    await cambiarEstado(tx, it.id, r.rows[0]?.estado_antes_de_anular ?? 'ACEPTADO', `SUNAT rechazó la anulación: ${mensaje}`);
    await crearAlerta(tx, { empresaId: d.empresaId, tipo: 'ANULACION_RECHAZADA', severidad: 'ROJO', mensaje: `SUNAT rechazó la anulación. El comprobante sigue vigente. ${mensaje}`, entidad: 'comprobantes', entidadId: it.id });
  }
}

/** Vuelve a poner en la cola un trabajo que quedó para revisar (después de corregir el problema). */
export async function reactivarTrabajo(db: Db, trabajoId: string, usuarioId?: string): Promise<boolean> {
  return enTransaccion(db, async (tx) => {
    const r = await tx.query(
      `UPDATE cola_envios SET estado = 'PENDIENTE', proximo_intento_en = now(), actualizado_en = now()
       WHERE id = $1 AND estado = 'FALLIDO_REVISAR' RETURNING empresa_id, referencia_id`,
      [trabajoId],
    );
    const f = r.rows[0];
    if (!f) return false;
    await tx.query(`UPDATE alertas SET resuelta_en = now() WHERE entidad = 'cola_envios' AND entidad_id = $1 AND resuelta_en IS NULL`, [trabajoId]);
    await tx.query(
      `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id) VALUES ($1, $2, 'REACTIVAR_ENVIO', 'cola_envios', $3)`,
      [f.empresa_id, usuarioId ?? null, trabajoId],
    );
    return true;
  });
}
