/**
 * Comprobantes antiguos (función opcional "antiguos"): los emitidos ANTES de este facturador
 * (SUNAT Operaciones en Línea, app Emprende u otro sistema). El dueño descarga los XML de
 * SUNAT y los sube aquí para consultarlos junto con los nuevos.
 *
 * No se vuelven a enviar a SUNAT ni tocan los correlativos ni la caja. Sí suman en las ventas e
 * IGV estimados del mes y salen en el Excel del contador (son ventas de la empresa: el dueño
 * emitía boletas en SUNAT el mismo mes en que empezó a usar el facturador).
 * Se guarda el XML tal cual llegó (con su huella) y se comprueba su firma.
 */
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import type { Almacen } from '../almacen/almacen.js';
import { codigoErrorPg, enTransaccion, type Db } from '../db/conexion.js';
import { aTexto2, dec } from '../dinero.js';
import { esFecha } from '../fechas.js';
import { verificarFirma } from '../firma/firmar.js';
import { idComprobanteLegible } from '../tipos.js';

/** Un XML de un comprobante pesa pocos KB; esto deja margen y frena archivos raros. */
const MAXIMO_XML = 1024 * 1024;
/** Un ZIP de SUNAT trae uno o pocos XML; con esto un ZIP enorme no llena la memoria. */
const MAXIMO_XML_POR_ZIP = 50;

export class ErrorAntiguo extends Error {}

export interface DatosAntiguo {
  tipo: '01' | '03' | '07' | '08';
  serie: string;
  numero: number;
  fechaEmision: string;
  rucEmisor: string;
  cliente: { tipoDoc?: string; numeroDoc?: string; nombre?: string };
  moneda: string;
  total: string;
  igv?: string;
}

export interface ResultadoSubida {
  archivo: string;
  resultado: 'GUARDADO' | 'REPETIDO' | 'ERROR';
  comprobante?: string;
  mensaje?: string;
}

const NOMBRE_TIPO: Record<DatosAntiguo['tipo'], string> = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito' };

/** Hijos directos con ese nombre (sin importar el prefijo del espacio de nombres). */
function hijos(e: Element, nombre: string): Element[] {
  const r: Element[] = [];
  for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as Element).localName === nombre) r.push(n as Element);
  return r;
}
const hijo = (e: Element | undefined, ...ruta: string[]): Element | undefined => {
  let actual = e;
  for (const nombre of ruta) actual = actual ? hijos(actual, nombre)[0] : undefined;
  return actual;
};
const textoDe = (e: Element | undefined, ...ruta: string[]) => hijo(e, ...ruta)?.textContent?.trim() || undefined;

/** Documento de identidad de una parte: UBL 2.1 (PartyIdentification) o UBL 2.0 (CustomerAssignedAccountID). */
function documentoDe(parte: Element | undefined): { tipoDoc?: string; numeroDoc?: string; nombre?: string } {
  const p = hijo(parte, 'Party');
  const id = hijo(p, 'PartyIdentification', 'ID');
  const numeroDoc = id?.textContent?.trim() || textoDe(parte, 'CustomerAssignedAccountID');
  const tipoDoc = id?.getAttribute('schemeID') || textoDe(parte, 'AdditionalAccountID');
  const nombre = textoDe(p, 'PartyLegalEntity', 'RegistrationName') ?? textoDe(p, 'PartyName', 'Name');
  return { ...(tipoDoc ? { tipoDoc } : {}), ...(numeroDoc ? { numeroDoc } : {}), ...(nombre ? { nombre } : {}) };
}

/** Lee los datos de un XML UBL de SUNAT (factura, boleta, nota de crédito o débito). */
export function leerXmlAntiguo(xml: string): DatosAntiguo {
  let raiz: Element | null;
  try {
    raiz = new DOMParser({ onError: () => undefined }).parseFromString(xml, 'text/xml').documentElement as unknown as Element | null;
  } catch {
    raiz = null;
  }
  if (!raiz || !['Invoice', 'CreditNote', 'DebitNote'].includes(raiz.localName)) {
    throw new ErrorAntiguo('No es el XML de una factura, boleta o nota. Descarga el XML (no el PDF) desde SUNAT.');
  }
  const tipo = (raiz.localName === 'CreditNote' ? '07' : raiz.localName === 'DebitNote' ? '08' : textoDe(raiz, 'InvoiceTypeCode')) as DatosAntiguo['tipo'];
  if (!['01', '03', '07', '08'].includes(tipo)) throw new ErrorAntiguo('El XML no dice si es factura o boleta (InvoiceTypeCode).');
  const m = /^([A-Z0-9]{4})-0*(\d{1,8})$/.exec(textoDe(raiz, 'ID') ?? '');
  if (!m) throw new ErrorAntiguo('El XML no tiene una serie y número válidos (ej. E001-25).');
  const fechaEmision = textoDe(raiz, 'IssueDate') ?? '';
  if (!esFecha(fechaEmision)) throw new ErrorAntiguo('El XML no tiene una fecha de emisión válida.');
  const rucEmisor = documentoDe(hijo(raiz, 'AccountingSupplierParty')).numeroDoc ?? '';
  const totales = hijo(raiz, tipo === '08' ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal');
  const total = textoDe(totales, 'PayableAmount') ?? '';
  const igv = textoDe(raiz, 'TaxTotal', 'TaxAmount');
  const monto = /^\d{1,12}(\.\d+)?$/;
  if (!monto.test(total) || (igv && !monto.test(igv))) throw new ErrorAntiguo('El XML no tiene un importe total válido.');
  return {
    tipo, serie: m[1]!, numero: Number(m[2]), fechaEmision, rucEmisor,
    cliente: documentoDe(hijo(raiz, 'AccountingCustomerParty')),
    moneda: textoDe(raiz, 'DocumentCurrencyCode') ?? 'PEN',
    total: aTexto2(dec(total)),
    ...(igv ? { igv: aTexto2(dec(igv)) } : {}),
  };
}

/** Los XML que trae lo subido: un XML suelto o un ZIP (como los descarga SUNAT). */
function xmlsDe(nombre: string, contenido: Buffer): { archivo: string; xml: string }[] {
  if (contenido.subarray(0, 2).toString('latin1') !== 'PK') {
    if (contenido.length > MAXIMO_XML) throw new ErrorAntiguo('El archivo es muy pesado para ser un XML de un comprobante.');
    return [{ archivo: nombre, xml: contenido.toString('utf8') }];
  }
  let archivos: Record<string, Uint8Array>;
  try {
    archivos = unzipSync(new Uint8Array(contenido), {
      filter: (f) => f.name.toLowerCase().endsWith('.xml') && f.originalSize <= MAXIMO_XML,
    });
  } catch {
    throw new ErrorAntiguo('El ZIP está dañado o no se puede abrir.');
  }
  const xmls = Object.entries(archivos)
    // Las constancias de SUNAT (R-...xml) no son el comprobante: se omiten.
    .filter(([n, d]) => !n.endsWith('/') && !/(^|\/)R-[^/]*$/i.test(n) && d.length <= MAXIMO_XML)
    .slice(0, MAXIMO_XML_POR_ZIP);
  if (!xmls.length) throw new ErrorAntiguo('El ZIP no trae ningún XML de comprobante.');
  return xmls.map(([n, d]) => ({ archivo: `${nombre} › ${n}`, xml: strFromU8(d) }));
}

/**
 * Guarda los comprobantes que trae un archivo (XML o ZIP). Cada XML tiene su propio
 * resultado: uno malo no impide guardar los demás. Subir dos veces el mismo no lo duplica.
 */
export async function subirAntiguos(
  db: Db,
  almacen: Almacen,
  d: { empresaId: string; nombre: string; contenido: Buffer; usuarioId?: string },
): Promise<ResultadoSubida[]> {
  const empresa = (await db.query(`SELECT ruc FROM empresas WHERE id = $1`, [d.empresaId])).rows[0];
  if (!empresa) throw new ErrorAntiguo('Empresa no encontrada.');
  const resultados: ResultadoSubida[] = [];
  for (const { archivo, xml } of xmlsDe(d.nombre.slice(0, 120), d.contenido)) {
    try {
      resultados.push({ archivo, ...(await guardarUno(db, almacen, d, empresa.ruc as string, xml)) });
    } catch (e) {
      if (!(e instanceof ErrorAntiguo)) throw e;
      resultados.push({ archivo, resultado: 'ERROR', mensaje: e.message });
    }
  }
  return resultados;
}

async function guardarUno(
  db: Db,
  almacen: Almacen,
  d: { empresaId: string; usuarioId?: string },
  ruc: string,
  xml: string,
): Promise<Omit<ResultadoSubida, 'archivo'>> {
  const x = leerXmlAntiguo(xml);
  const comprobante = `${NOMBRE_TIPO[x.tipo]} ${idComprobanteLegible(x.serie, x.numero)}`;
  if (x.rucEmisor !== ruc) throw new ErrorAntiguo(`${comprobante} es del RUC ${x.rucEmisor || 'desconocido'}, no de esta empresa (${ruc}).`);
  const propio = await db.query(`SELECT 1 FROM comprobantes WHERE empresa_id = $1 AND tipo_comprobante = $2 AND serie = $3 AND numero = $4`, [
    d.empresaId, x.tipo, x.serie, x.numero,
  ]);
  if (propio.rowCount) throw new ErrorAntiguo(`${comprobante} ya está en el facturador: no hace falta subirlo.`);
  const ya = await db.query(`SELECT 1 FROM comprobantes_antiguos WHERE empresa_id = $1 AND tipo = $2 AND serie = $3 AND numero = $4`, [
    d.empresaId, x.tipo, x.serie, x.numero,
  ]);
  if (ya.rowCount) return { resultado: 'REPETIDO', comprobante, mensaje: 'Ya estaba guardado.' };

  let firmaValida = false;
  try {
    firmaValida = verificarFirma(xml).valida;
  } catch {
    firmaValida = false;
  }
  const contenido = Buffer.from(xml, 'utf8');
  const sha256 = createHash('sha256').update(contenido).digest('hex');
  const ruta = `${ruc}/antiguos/${x.fechaEmision.slice(0, 4)}/${ruc}-${x.tipo}-${x.serie}-${x.numero}-${sha256.slice(0, 12)}.xml`;
  try {
    await enTransaccion(db, async (tx) => {
      await almacen.guardar(ruta, contenido, tx);
      const a = await tx.query(
        `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
         VALUES ($1, 'comprobantes_antiguos', $1, 'XML', $2, $3, $4, (current_date + interval '6 years')::date) RETURNING id`,
        [d.empresaId, ruta, sha256, contenido.length],
      );
      await tx.query(
        `INSERT INTO comprobantes_antiguos (empresa_id, tipo, serie, numero, fecha_emision, cliente_tipo_doc, cliente_doc, cliente_nombre,
                                            moneda, total, igv, firma_valida, archivo_id, subido_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          d.empresaId, x.tipo, x.serie, x.numero, x.fechaEmision, x.cliente.tipoDoc?.slice(0, 2) ?? null, x.cliente.numeroDoc?.slice(0, 20) ?? null,
          x.cliente.nombre?.slice(0, 300) ?? null, x.moneda.slice(0, 3), x.total, x.igv ?? null, firmaValida, a.rows[0].id, d.usuarioId ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'SUBIR_ANTIGUO', 'archivos', $3, $4)`,
        [d.empresaId, d.usuarioId ?? null, a.rows[0].id, JSON.stringify({ comprobante, sha256 })],
      );
    });
  } catch (e) {
    // Dos subidas del mismo a la vez: gana una, la otra lo ve como repetido.
    if (codigoErrorPg(e) === '23505') return { resultado: 'REPETIDO', comprobante, mensaje: 'Ya estaba guardado.' };
    throw e;
  }
  const serieNuestra = await db.query(`SELECT 1 FROM series WHERE empresa_id = $1 AND serie = $2`, [d.empresaId, x.serie]);
  const avisos = [
    ...(!firmaValida ? ['su firma no se pudo comprobar: el archivo pudo ser modificado'] : []),
    ...(serieNuestra.rowCount ? [`la serie ${x.serie} también la usa este facturador; revisa con tu contador que los números no se repitan`] : []),
  ];
  return { resultado: 'GUARDADO', comprobante, ...(avisos.length ? { mensaje: `Guardado, pero ${avisos.join('; y ')}.` } : {}) };
}

export interface ComprobanteAntiguo {
  id: string;
  tipo: string;
  comprobante: string;
  fechaEmision: string;
  cliente: string;
  moneda: string;
  total: string;
  igv: string | null;
  firmaValida: boolean;
}

/** Los más recientes primero; `buscar` filtra por número, documento o nombre del cliente. */
export async function listarAntiguos(db: Db, empresaId: string, opciones: { buscar?: string; anio?: number } = {}): Promise<ComprobanteAntiguo[]> {
  const buscar = opciones.buscar?.trim().slice(0, 60) || null;
  const r = await db.query(
    `SELECT id, tipo, serie, numero, to_char(fecha_emision, 'YYYY-MM-DD') AS fecha, cliente_doc, cliente_nombre, moneda, total, igv, firma_valida
       FROM comprobantes_antiguos
      WHERE empresa_id = $1
        AND ($2::int IS NULL OR extract(year FROM fecha_emision) = $2)
        AND ($3::text IS NULL OR serie || '-' || numero ILIKE '%' || $3 || '%' OR cliente_doc ILIKE '%' || $3 || '%'
             OR cliente_nombre ILIKE '%' || $3 || '%')
      ORDER BY fecha_emision DESC, serie, numero DESC
      LIMIT 200`,
    [empresaId, opciones.anio ?? null, buscar?.replace(/[%_\\]/g, (c) => `\\${c}`) ?? null],
  );
  return r.rows.map((f) => ({
    id: f.id, tipo: NOMBRE_TIPO[f.tipo as DatosAntiguo['tipo']], comprobante: idComprobanteLegible(f.serie, Number(f.numero)), fechaEmision: f.fecha,
    cliente: [f.cliente_doc, f.cliente_nombre].filter(Boolean).join(' · ') || '—', moneda: f.moneda, total: f.total, igv: f.igv, firmaValida: f.firma_valida,
  }));
}

/** El XML tal como se subió (o undefined si no es de la empresa). */
export async function xmlAntiguo(db: Db, almacen: Almacen, empresaId: string, id: string): Promise<{ nombre: string; xml: Buffer } | undefined> {
  const f = (await db.query(
    `SELECT a.ruta_almacenamiento AS ruta, a.sha256, e.ruc, c.tipo, c.serie, c.numero
       FROM comprobantes_antiguos c JOIN archivos a ON a.id = c.archivo_id JOIN empresas e ON e.id = c.empresa_id
      WHERE c.id = $1 AND c.empresa_id = $2`,
    [id, empresaId],
  )).rows[0];
  if (!f) return undefined;
  const xml = await almacen.leer(f.ruta);
  if (createHash('sha256').update(xml).digest('hex') !== f.sha256) throw new Error('El XML guardado fue alterado (su huella no coincide).');
  return { nombre: `${f.ruc}-${f.tipo}-${f.serie}-${f.numero}.xml`, xml };
}
