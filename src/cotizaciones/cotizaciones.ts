/**
 * Cotizaciones (proformas): un presupuesto para el cliente ANTES de vender.
 *
 * No es comprobante de pago: no va a SUNAT, no cuenta como venta y su PDF lo dice en grande.
 * Cuando el cliente acepta, se emite la boleta o factura normal y la cotización queda
 * enlazada a ella (CONVERTIDA). Lo cotizado no se cambia: si hay que corregir, se anula y se
 * hace otra. Montos con IGV incluido y decimales exactos.
 */
import PDFDocument from 'pdfkit';
import type { Almacen } from '../almacen/almacen.js';
import { enTransaccion, type Db } from '../db/conexion.js';
import { dec, sumar } from '../dinero.js';
import { sumarDias } from '../fechas.js';
import { formatearMonto } from '../pdf/representacion.js';
import { esDniValido, esRucValido } from '../validaciones/documentos.js';

export class ErrorCotizacion extends Error {}

const DOCUMENTOS = ['DNI', 'RUC', 'CE', 'PASAPORTE', 'NINGUNO'] as const;
const CANTIDAD = /^\d{1,12}(\.\d{1,10})?$/;
const PRECIO = /^\d{1,12}(\.\d{1,10})?$/;
const MAX_ITEMS = 100;

export interface EntradaCotizacion {
  cliente: { tipoDocumento: string; numero: string; nombre: string };
  items: { codigo?: string; descripcion: string; cantidad: string; precio: string }[];
  /** Días que vale la cotización (1 a 90). */
  diasValidez: number;
  nota?: string;
}

export interface Cotizacion {
  id: string;
  numero: string;
  fecha: string;
  validaHasta: string;
  cliente: { tipoDocumento: string; numero: string; nombre: string };
  items: { codigo: string | null; descripcion: string; cantidad: string; precio: string; importe: string }[];
  nota: string | null;
  total: string;
  estado: 'VIGENTE' | 'CONVERTIDA' | 'ANULADA';
  /** Número del comprobante emitido a partir de esta cotización. */
  comprobante: string | null;
}

export const numeroCotizacion = (n: number) => `COT-${String(n).padStart(6, '0')}`;

/** Revisa los datos y calcula los importes. Devuelve los errores en español, todos juntos. */
function validar(e: EntradaCotizacion) {
  const errores: string[] = [];
  const tipo = e.cliente.tipoDocumento.toUpperCase();
  const numero = e.cliente.numero.trim();
  if (!(DOCUMENTOS as readonly string[]).includes(tipo)) errores.push('Tipo de documento del cliente inválido.');
  if (tipo === 'DNI' && !esDniValido(numero)) errores.push('El DNI debe tener 8 dígitos.');
  if (tipo === 'RUC' && !esRucValido(numero)) errores.push('El RUC no es válido (11 dígitos con dígito verificador correcto).');
  if (!Number.isInteger(e.diasValidez) || e.diasValidez < 1 || e.diasValidez > 90) errores.push('La validez debe ser de 1 a 90 días.');
  if (!e.items.length) errores.push('Agrega al menos un producto.');
  if (e.items.length > MAX_ITEMS) errores.push(`Máximo ${MAX_ITEMS} productos por cotización.`);
  const items = e.items.map((x, i) => {
    const n = `Producto ${i + 1}`;
    const descripcion = x.descripcion.trim();
    if (!descripcion || descripcion.length > 250) errores.push(`${n}: escribe la descripción.`);
    if (!CANTIDAD.test(x.cantidad) || dec(x.cantidad).lte(0)) errores.push(`${n}: cantidad inválida (ej. 1 o 2.5).`);
    if (!PRECIO.test(x.precio)) errores.push(`${n}: precio inválido (ej. 150.00).`);
    const importe = CANTIDAD.test(x.cantidad) && PRECIO.test(x.precio) ? dec(x.cantidad).times(dec(x.precio)).toDecimalPlaces(2) : dec('0');
    return { codigo: x.codigo?.trim() || null, descripcion, cantidad: x.cantidad, precio: x.precio, importe };
  });
  if (errores.length) throw new ErrorCotizacion(errores.join(' '));
  return {
    cliente: { tipoDocumento: tipo, numero: tipo === 'NINGUNO' ? '' : numero, nombre: e.cliente.nombre.trim().slice(0, 200) },
    items,
    total: sumar(items.map((x) => x.importe)),
  };
}

export async function crearCotizacion(db: Db, empresaId: string, e: EntradaCotizacion, usuarioId: string, hoy: string): Promise<Cotizacion> {
  const v = validar(e);
  const id = await enTransaccion(db, async (tx) => {
    // Un número por empresa, sin repetidos aunque dos personas coticen a la vez.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cotizacion-' || $1))`, [empresaId]);
    const numero = (await tx.query(`SELECT coalesce(max(numero), 0) + 1 AS n FROM cotizaciones WHERE empresa_id = $1`, [empresaId])).rows[0].n as number;
    const nuevo = (await tx.query(
      `INSERT INTO cotizaciones (empresa_id, numero, fecha, valida_hasta, cliente_documento, cliente_numero, cliente_nombre, nota, total, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [empresaId, numero, hoy, sumarDias(hoy, e.diasValidez), v.cliente.tipoDocumento, v.cliente.numero, v.cliente.nombre,
        e.nota?.trim().slice(0, 500) || null, v.total.toFixed(2), usuarioId],
    )).rows[0].id as string;
    for (const [i, x] of v.items.entries()) {
      await tx.query(
        `INSERT INTO cotizacion_items (cotizacion_id, orden, codigo, descripcion, cantidad, precio, importe) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [nuevo, i + 1, x.codigo, x.descripcion, x.cantidad, x.precio, x.importe.toFixed(2)],
      );
    }
    return nuevo;
  });
  const c = await cargarCotizacion(db, empresaId, id);
  if (!c) throw new Error('La cotización recién guardada no se encontró.');
  return c;
}

export async function cargarCotizacion(db: Db, empresaId: string, id: string): Promise<Cotizacion | undefined> {
  return (await leer(db, empresaId, { id }))[0];
}

/** Las últimas 30 cotizaciones de la empresa. */
export const listarCotizaciones = (db: Db, empresaId: string) => leer(db, empresaId, {});

async function leer(db: Db, empresaId: string, filtro: { id?: string }): Promise<Cotizacion[]> {
  const r = await db.query(
    `SELECT k.id, k.numero, k.fecha::text AS fecha, k.valida_hasta::text AS valida_hasta, k.cliente_documento, k.cliente_numero, k.cliente_nombre,
            k.nota, k.total::text AS total, k.estado, c.serie || '-' || lpad(c.numero::text, 8, '0') AS comprobante,
            (SELECT json_agg(json_build_object('codigo', i.codigo, 'descripcion', i.descripcion, 'cantidad', i.cantidad::text,
                    'precio', i.precio::text, 'importe', i.importe::text) ORDER BY i.orden) FROM cotizacion_items i WHERE i.cotizacion_id = k.id) AS items
       FROM cotizaciones k LEFT JOIN comprobantes c ON c.id = k.comprobante_id
      WHERE k.empresa_id = $1 AND ($2::uuid IS NULL OR k.id = $2)
      ORDER BY k.numero DESC LIMIT 30`,
    [empresaId, filtro.id ?? null],
  );
  return r.rows.map((f) => ({
    id: f.id, numero: numeroCotizacion(f.numero), fecha: f.fecha, validaHasta: f.valida_hasta,
    cliente: { tipoDocumento: f.cliente_documento, numero: f.cliente_numero, nombre: f.cliente_nombre },
    // Cantidad y precio sin ceros de relleno ("2.0000000000" → "2"); importe con 2 decimales.
    items: (f.items ?? []).map((x: { codigo: string | null; descripcion: string; cantidad: string; precio: string; importe: string }) => ({
      codigo: x.codigo, descripcion: x.descripcion, cantidad: dec(x.cantidad).toString(), precio: dec(x.precio).toFixed(Math.max(2, dec(x.precio).decimalPlaces())), importe: dec(x.importe).toFixed(2),
    })),
    nota: f.nota, total: dec(f.total).toFixed(2), estado: f.estado, comprobante: f.comprobante,
  }));
}

/** Anula una cotización vigente (no se borra). */
export async function anularCotizacion(db: Db, empresaId: string, id: string, usuarioId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE cotizaciones SET estado = 'ANULADA', cambiado_por = $3, cambiado_en = now() WHERE id = $1 AND empresa_id = $2 AND estado = 'VIGENTE' RETURNING id`,
    [id, empresaId, usuarioId],
  );
  return Boolean(r.rowCount);
}

/** Enlaza la cotización con la boleta o factura emitida a partir de ella. */
export async function marcarConvertida(db: Db, empresaId: string, id: string, comprobanteId: string, usuarioId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE cotizaciones SET estado = 'CONVERTIDA', comprobante_id = $3, cambiado_por = $4, cambiado_en = now()
      WHERE id = $1 AND empresa_id = $2 AND estado = 'VIGENTE'
        AND EXISTS (SELECT 1 FROM comprobantes WHERE id = $3 AND empresa_id = $2 AND tipo_comprobante IN ('01', '03'))
      RETURNING id`,
    [id, empresaId, comprobanteId, usuarioId],
  );
  return Boolean(r.rowCount);
}

// ---------------------------------------------------------------------------
// PDF (A4) con logo y datos de la empresa
// ---------------------------------------------------------------------------

const fechaPeru = (iso: string) => iso.split('-').reverse().join('/');

export async function pdfCotizacion(db: Db, empresaId: string, c: Cotizacion, almacen?: Almacen): Promise<Buffer> {
  const e = (await db.query(
    `SELECT e.ruc, e.razon_social, e.nombre_comercial, e.direccion, e.distrito, e.provincia, e.departamento, a.ruta_almacenamiento AS logo
       FROM empresas e LEFT JOIN archivos a ON a.id = e.logo_archivo_id WHERE e.id = $1`,
    [empresaId],
  )).rows[0];
  const logo = e?.logo && almacen ? await almacen.leer(e.logo).catch(() => undefined) : undefined;

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Producer: 'Facturador SUNAT', Title: c.numero } });
  const izq = 40;
  const ancho = 595.28 - 80;
  let x = izq;
  if (logo) {
    try {
      doc.image(logo, izq, 40, { fit: [80, 60] });
      x = izq + 90;
    } catch {
      // Logo inválido: se imprime sin logo.
    }
  }
  doc.font('Helvetica-Bold').fontSize(12).text(e.razon_social, x, 40, { width: 300 });
  doc.font('Helvetica').fontSize(8.5);
  if (e.nombre_comercial) doc.text(e.nombre_comercial, { width: 300 });
  doc.text(`RUC ${e.ruc}`, { width: 300 });
  doc.text(`${e.direccion} — ${e.distrito}, ${e.provincia}, ${e.departamento}`, { width: 300 });

  doc.lineWidth(1).roundedRect(izq + ancho - 180, 40, 180, 60, 4).stroke();
  doc.font('Helvetica-Bold').fontSize(13).text('COTIZACIÓN', izq + ancho - 180, 52, { width: 180, align: 'center' });
  doc.fontSize(12).text(c.numero, izq + ancho - 180, 72, { width: 180, align: 'center' });

  let y = 120;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#b42318')
    .text('NO ES COMPROBANTE DE PAGO — Al pagar se emite la boleta o factura electrónica.', izq, y, { width: ancho, align: 'center' });
  doc.fillColor('black');
  if (c.estado !== 'VIGENTE') doc.text(c.estado === 'ANULADA' ? '*** ANULADA ***' : `*** CONVERTIDA EN ${c.comprobante} ***`, izq, doc.y + 4, { width: ancho, align: 'center' });
  y = doc.y + 12;

  const pares: [string, string][] = [
    ['Fecha', fechaPeru(c.fecha)],
    ['Válida hasta', fechaPeru(c.validaHasta)],
    ['Cliente', c.cliente.nombre || '—'],
    ...(c.cliente.numero ? [[c.cliente.tipoDocumento, c.cliente.numero] as [string, string]] : []),
  ];
  doc.fontSize(9);
  for (const [k, v] of pares) {
    doc.font('Helvetica-Bold').text(`${k}:`, izq, y, { width: 90 });
    doc.font('Helvetica').text(v, izq + 95, y, { width: ancho - 95 });
    y = doc.y + 3;
  }
  y += 8;

  const cols = [{ t: 'CANT.', w: 50, a: 'right' as const }, { t: 'DESCRIPCIÓN', w: 0, a: 'left' as const }, { t: 'P. UNIT.', w: 80, a: 'right' as const }, { t: 'IMPORTE', w: 80, a: 'right' as const }];
  cols[1]!.w = ancho - cols.reduce((s, k) => s + k.w, 0);
  const fila = (valores: string[], negrita: boolean) => {
    let cx = izq;
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const alto = Math.max(...valores.map((v, i) => doc.heightOfString(v, { width: cols[i]!.w - 8 })));
    if (y + alto > 790) { doc.addPage(); y = 40; }
    valores.forEach((v, i) => { doc.text(v, cx + 4, y + 4, { width: cols[i]!.w - 8, align: cols[i]!.a }); cx += cols[i]!.w; });
    y += alto + 8;
    doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.5).strokeColor('#cccccc').stroke().strokeColor('black');
  };
  doc.rect(izq, y, ancho, 18).fill('#eeeeee').fillColor('black');
  fila(cols.map((k) => k.t), true);
  for (const it of c.items) fila([it.cantidad, it.descripcion, formatearMonto(dec(it.precio)), formatearMonto(dec(it.importe))], false);

  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).text(`TOTAL S/ ${formatearMonto(dec(c.total))}`, izq, y, { width: ancho, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).text('Precios en soles con IGV incluido.', izq, doc.y + 2, { width: ancho, align: 'right' });
  if (c.nota) {
    doc.moveDown();
    doc.font('Helvetica-Bold').fontSize(9).text('Nota:', izq, doc.y, { width: ancho });
    doc.font('Helvetica').text(c.nota, { width: ancho });
  }

  return new Promise((ok, mal) => {
    const partes: Buffer[] = [];
    doc.on('data', (p: Buffer) => partes.push(p));
    doc.on('end', () => ok(Buffer.concat(partes)));
    doc.on('error', mal);
    doc.end();
  });
}
