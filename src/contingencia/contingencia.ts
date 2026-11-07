/**
 * Vender sin internet: boletas y facturas IMPRESAS de contingencia (ver migración 040).
 *
 * Sin señal, el panel anota la venta en el celular con la serie y el número de la boleta
 * impresa que se entregó al cliente (ej. 0001-123) y la manda aquí cuando vuelve el
 * internet. Se valida y se calcula EXACTAMENTE igual que una boleta electrónica (mismo
 * IGV por fecha, mismo límite para identificar al cliente). Luego el facturador arma el
 * "Resumen de comprobantes impresos" (archivo RF) para cargarlo en SUNAT Operaciones en
 * Línea dentro de los 7 días.
 *
 * Formato del archivo (consultado el 07/11/2026): guía SUNAT "Resumen de comprobantes
 * impresos" v1.1 y Anexo II de la R.S. 254-2018/SUNAT. Nombre RUC-RF-DDMMAAAA-NN.TXT
 * (DDMMAAAA = fecha de emisión), dentro de un ZIP con el mismo nombre; campos separados
 * por "|"; un comprobante por línea. Si se manda otro archivo de la misma fecha, el último
 * reemplaza por completo al anterior: por eso cada archivo lleva TODAS las ventas del día.
 */
import { createHash, randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { Almacen } from '../almacen/almacen.js';
import { leerPedido } from '../api/solicitud.js';
import { prepararComprobante } from '../comprobantes/preparar.js';
import { cargarContexto, parametro } from '../comprobantes/repositorio.js';
import { codigoErrorPg, enTransaccion, restriccionPg, type Db } from '../db/conexion.js';
import { aTexto2 } from '../dinero.js';
import { ahoraLima, diasEntre, esFecha, sumarDias } from '../fechas.js';
import { TipoComprobante } from '../tipos.js';

/** Hasta cuántos días atrás se acepta una venta anotada sin señal (un celular apagado varios días). */
const DIAS_ATRAS_MAXIMO = 60;

export class ErrorContingencia extends Error {
  constructor(readonly errores: string[]) {
    super(errores.join(' '));
  }
}

export interface VentaContingencia {
  id: string;
  tipo: '01' | '03';
  comprobante: string;
  fechaEmision: string;
  cliente: string;
  total: string;
}

/**
 * Registra una venta anotada sin internet. `cuerpo` es el mismo que el de Vender, más
 * `contingencia: { origen, serie, numero, fecha, hora, anotadoEn }`.
 */
export async function registrarContingencia(
  db: Db,
  d: { empresaId: string; canalId?: string; usuarioId?: string; cuerpo: Record<string, unknown>; hoy?: string },
): Promise<{ resultado: 'REGISTRADA' | 'REPETIDA'; venta: VentaContingencia }> {
  const k = (typeof d.cuerpo.contingencia === 'object' && d.cuerpo.contingencia) || {};
  const c = k as Record<string, unknown>;
  const origen = typeof c.origen === 'string' ? c.origen.trim() : '';
  const serie = typeof c.serie === 'string' ? c.serie.trim() : '';
  const numero = typeof c.numero === 'number' ? c.numero : Number(typeof c.numero === 'string' ? c.numero.trim() : NaN);
  const fecha = typeof c.fecha === 'string' ? c.fecha : '';
  const hora = typeof c.hora === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(c.hora) ? c.hora.slice(0, 5) + ':00' : '';
  const anotadoEn = typeof c.anotadoEn === 'string' && !Number.isNaN(Date.parse(c.anotadoEn)) ? new Date(c.anotadoEn) : new Date();
  const hoy = d.hoy ?? ahoraLima().fecha;

  const errores: string[] = [];
  if (origen.length < 8 || origen.length > 100) errores.push('Falta el código interno de la venta.');
  if (!/^\d{4}$/.test(serie)) errores.push('La serie de la boleta impresa son 4 números, como está impresa (ej. 0001).');
  if (!Number.isSafeInteger(numero) || numero < 1 || numero > 99_999_999) errores.push('Escribe el número de la boleta impresa (ej. 123).');
  if (!esFecha(fecha) || fecha > hoy) errores.push('La fecha de la venta no es válida.');
  else if (diasEntre(fecha, hoy) > DIAS_ATRAS_MAXIMO) errores.push(`La venta es de hace más de ${DIAS_ATRAS_MAXIMO} días: regístrala con tu contador.`);
  if (!hora) errores.push('Falta la hora de la venta.');

  // Ya llegó antes (se cortó la señal al enviarla): se devuelve la misma, sin error.
  const ya = await buscarPorOrigen(db, d.empresaId, origen);
  if (ya) return { resultado: 'REPETIDA', venta: ya };

  // Mismas reglas y cálculos que una boleta electrónica (serie electrónica solo para validar).
  const leido = leerPedido({ ...d.cuerpo, pedido: origen || 'contingencia', fecha: esFecha(fecha) ? fecha : hoy, serie: undefined });
  if (!leido.ok) throw new ErrorContingencia([...errores, ...leido.errores]);
  const s = leido.valor.solicitud;
  if (s.tipo !== TipoComprobante.BOLETA && s.tipo !== TipoComprobante.FACTURA) errores.push('Sin internet solo se registran boletas y facturas.');
  if (s.formaPago.tipo !== 'CONTADO') errores.push('Sin internet solo se registran ventas al contado.');
  if (errores.length) throw new ErrorContingencia(errores);
  const ctx = await cargarContexto(db, d.empresaId, fecha);
  const p = prepararComprobante({ ...s, horaEmision: hora }, ctx);
  if (!p.ok) throw new ErrorContingencia(p.errores);
  const t = p.comprobante.totales;

  try {
    const r = await db.query(
      `INSERT INTO ventas_contingencia (empresa_id, origen, tipo, serie, numero, fecha_emision, hora_emision, cliente_tipo_doc, cliente_doc, cliente_nombre,
                                        total_gravado, total_exonerado, total_inafecto, total_igv, importe_total, items, medio_pago, canal_id, registrado_por, anotado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (empresa_id, origen) DO NOTHING RETURNING id`,
      [
        d.empresaId, origen, s.tipo, serie, numero, fecha, hora, s.cliente.tipoDoc, s.cliente.numeroDoc, s.cliente.nombre,
        aTexto2(t.gravado), aTexto2(t.exonerado), aTexto2(t.inafecto), aTexto2(t.igv), aTexto2(t.importeTotal),
        JSON.stringify(p.comprobante.items.map((x) => ({ descripcion: x.descripcion, cantidad: x.cantidad.toString(), codigo: x.codigo ?? null, precio: x.precioUnitario.toString(), total: aTexto2(x.total) }))),
        leido.valor.pago?.medio ?? null, d.canalId ?? null, d.usuarioId ?? null, anotadoEn,
      ],
    );
    if (r.rowCount) {
      await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'VENTA_CONTINGENCIA', 'ventas_contingencia', $3, $4)`, [
        d.empresaId, d.usuarioId ?? null, r.rows[0].id, JSON.stringify({ serie, numero, fecha, total: aTexto2(t.importeTotal) }),
      ]);
    }
  } catch (e) {
    if (codigoErrorPg(e) === '23505' && restriccionPg(e) === 'ventas_contingencia_empresa_id_tipo_serie_numero_key') {
      throw new ErrorContingencia([`La ${s.tipo === '01' ? 'factura' : 'boleta'} impresa ${serie}-${numero} ya está registrada. Revisa el número.`]);
    }
    throw e;
  }
  return { resultado: 'REGISTRADA', venta: (await buscarPorOrigen(db, d.empresaId, origen))! };
}

const COLUMNAS = `id, tipo, serie, numero, to_char(fecha_emision, 'YYYY-MM-DD') AS fecha, cliente_doc, cliente_nombre, importe_total::text AS total`;
function aVenta(f: Record<string, unknown>): VentaContingencia {
  return {
    id: f.id as string, tipo: f.tipo as '01' | '03', comprobante: `${f.serie}-${f.numero}`, fechaEmision: f.fecha as string,
    cliente: f.cliente_doc === '-' ? (f.cliente_nombre as string) : `${f.cliente_doc} · ${f.cliente_nombre}`, total: f.total as string,
  };
}
async function buscarPorOrigen(db: Db, empresaId: string, origen: string): Promise<VentaContingencia | undefined> {
  const f = (await db.query(`SELECT ${COLUMNAS} FROM ventas_contingencia WHERE empresa_id = $1 AND origen = $2`, [empresaId, origen])).rows[0];
  return f ? aVenta(f) : undefined;
}

export interface DiaContingencia {
  fecha: string;
  ventas: VentaContingencia[];
  total: string;
  /** El último archivo generado para esta fecha incluye todas sus ventas. */
  informado: boolean;
  /** Último día para cargar el archivo en SUNAT. */
  vence: string;
  diasRestantes: number;
}

/** Ventas de contingencia agrupadas por fecha (las de los últimos 60 días), las más nuevas primero. */
export async function diasDeContingencia(db: Db, empresaId: string, hoy = ahoraLima().fecha): Promise<DiaContingencia[]> {
  const r = await db.query(
    `SELECT ${COLUMNAS},
            coalesce((SELECT v.id = ANY(i.ventas) FROM informes_contingencia i
                       WHERE i.empresa_id = v.empresa_id AND i.fecha_emision = v.fecha_emision ORDER BY i.correlativo DESC LIMIT 1), false) AS informada
       FROM ventas_contingencia v
      WHERE v.empresa_id = $1 AND v.fecha_emision >= $2::date
      ORDER BY v.fecha_emision DESC, v.serie, v.numero`,
    [empresaId, sumarDias(hoy, -DIAS_ATRAS_MAXIMO)],
  );
  const dias = new Map<string, { ventas: VentaContingencia[]; informado: boolean; centimos: bigint }>();
  for (const f of r.rows) {
    const dia = dias.get(f.fecha) ?? { ventas: [], informado: true, centimos: 0n };
    dia.ventas.push(aVenta(f));
    dia.informado &&= f.informada as boolean;
    dia.centimos += BigInt((f.total as string).replace('.', ''));
    dias.set(f.fecha, dia);
  }
  const plazo = await plazoInformar(db, hoy);
  return [...dias].map(([fecha, x]) => ({
    fecha, ventas: x.ventas, informado: x.informado, total: `${x.centimos / 100n}.${String(x.centimos % 100n).padStart(2, '0')}`,
    vence: sumarDias(fecha, plazo), diasRestantes: diasEntre(hoy, sumarDias(fecha, plazo)),
  }));
}

async function plazoInformar(db: Db, fecha: string): Promise<number> {
  // El plazo no depende del régimen: se lee la fila general (regimen NULL).
  return (await parametro(db, 'PLAZO_INFORMAR_CONTINGENCIA_DIAS', 'GENERAL', fecha)).toNumber();
}

const fechaSunat = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Sin "|" ni saltos de línea dentro de un campo: romperían el archivo. */
const campo = (v: string) => v.replace(/[|\s]+/g, ' ').trim();

/** Una línea por comprobante, con los 26 campos del Anexo II de la R.S. 254-2018 (vacíos los que no aplican). */
function lineaRf(v: Record<string, string>, motivo: string): string {
  const campos = [
    motivo, '01', fechaSunat(v.fecha!), v.tipo!, v.serie!, v.numero!, '',
    v.cliente_tipo_doc === '0' ? '0' : v.cliente_tipo_doc!, v.cliente_doc === '-' ? '' : campo(v.cliente_doc!), campo(v.cliente_nombre!).slice(0, 200),
    v.moneda!, v.total_gravado!, v.total_exonerado!, v.total_inafecto!, '0.00', '0.00', v.total_igv!, '0.00', v.importe_total!,
    '', '', '', '', '', '', '',
  ];
  return `${campos.join('|')}|`;
}

/**
 * Arma el archivo RF de una fecha con TODAS sus ventas de contingencia y lo guarda.
 * Devuelve el ZIP listo para cargar en SUNAT Operaciones en Línea.
 */
export async function generarInforme(
  db: Db,
  almacen: Almacen,
  d: { empresaId: string; fecha: string; usuarioId?: string },
): Promise<{ nombre: string; zip: Buffer; ventas: number }> {
  if (!esFecha(d.fecha)) throw new ErrorContingencia(['Fecha inválida.']);
  return enTransaccion(db, async (tx) => {
    // Un informe a la vez por empresa: así dos personas no sacan el mismo correlativo.
    const e = (await tx.query(`SELECT ruc FROM empresas WHERE id = $1 FOR UPDATE`, [d.empresaId])).rows[0];
    const ventas = (await tx.query(
      `SELECT id, tipo, serie, numero::text AS numero, to_char(fecha_emision, 'YYYY-MM-DD') AS fecha, motivo::text AS motivo, cliente_tipo_doc, cliente_doc,
              cliente_nombre, moneda, total_gravado::text AS total_gravado, total_exonerado::text AS total_exonerado, total_inafecto::text AS total_inafecto,
              total_igv::text AS total_igv, importe_total::text AS importe_total
         FROM ventas_contingencia WHERE empresa_id = $1 AND fecha_emision = $2 ORDER BY tipo, serie, numero`,
      [d.empresaId, d.fecha],
    )).rows;
    if (!ventas.length) throw new ErrorContingencia(['No hay ventas sin internet registradas en esa fecha.']);
    const correlativo = Number((await tx.query(
      `SELECT coalesce(max(correlativo), 0) + 1 AS n FROM informes_contingencia WHERE empresa_id = $1 AND fecha_emision = $2`,
      [d.empresaId, d.fecha],
    )).rows[0].n);
    if (correlativo > 99) throw new ErrorContingencia(['SUNAT permite hasta 99 archivos por fecha.']);
    const base = `${e.ruc}-RF-${d.fecha.slice(8, 10)}${d.fecha.slice(5, 7)}${d.fecha.slice(0, 4)}-${String(correlativo).padStart(2, '0')}`;
    const txt = ventas.map((v) => lineaRf(v, v.motivo)).join('\r\n') + '\r\n';
    const zip = Buffer.from(zipSync({ [`${base}.TXT`]: strToU8(txt) }, { level: 9 }));
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const ruta = `${e.ruc}/contingencia/${base}-${sha256.slice(0, 12)}.zip`;
    const informeId = randomUUID();
    await almacen.guardar(ruta, zip, tx);
    const a = await tx.query(
      `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
       VALUES ($1, 'informes_contingencia', $2, 'ZIP', $3, $4, $5, (current_date + interval '6 years')::date) RETURNING id`,
      [d.empresaId, informeId, ruta, sha256, zip.length],
    );
    await tx.query(
      `INSERT INTO informes_contingencia (id, empresa_id, fecha_emision, correlativo, ventas, archivo_id, generado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [informeId, d.empresaId, d.fecha, correlativo, ventas.map((v) => v.id), a.rows[0].id, d.usuarioId ?? null],
    );
    return { nombre: `${base}.ZIP`, zip, ventas: ventas.length };
  });
}
