/**
 * Representación impresa (PDF) de factura, boleta y nota de crédito, con código QR.
 *
 * Formatos:
 *   - A4: hoja completa, para enviar por WhatsApp o correo.
 *   - TICKET_80: rollo de 80 mm para impresora térmica (ventas en persona).
 *
 * Contenido del QR (mismo orden que usa Greenter, aceptado en la práctica):
 *   RUC|TIPO|SERIE|NÚMERO|IGV|TOTAL|FECHA|TIPO DOC CLIENTE|NÚMERO DOC CLIENTE|
 * ⚠️ Confirmar contra el anexo vigente de SUNAT sobre la representación impresa.
 *
 * Los PDF de pruebas (ambiente BETA) llevan la marca "SIN VALOR LEGAL".
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { montoEnLetras } from '../calculos/monto-en-letras.js';
import { MOTIVOS_NOTA_CREDITO, MOTIVOS_NOTA_DEBITO } from '../catalogos.js';
import { aTexto2, aTextoHasta, dec, type Decimal } from '../dinero.js';
import { TipoComprobante, idComprobanteLegible, notaDe, type Comprobante } from '../tipos.js';

export type FormatoPdf = 'A4' | 'TICKET_80';

export interface DatosPdf {
  comprobante: Comprobante;
  /** DigestValue de la firma: obligatorio, solo se imprime un comprobante firmado. */
  hashFirma: string;
  estado: string;
  ambiente: 'BETA' | 'PRODUCCION';
  marca?: string;
  /** Logo en PNG o JPG. */
  logo?: Buffer;
}

export class ErrorPdf extends Error {}

const TITULOS: Record<string, string> = {
  [TipoComprobante.FACTURA]: 'FACTURA ELECTRÓNICA',
  [TipoComprobante.BOLETA]: 'BOLETA DE VENTA ELECTRÓNICA',
  [TipoComprobante.NOTA_CREDITO]: 'NOTA DE CRÉDITO ELECTRÓNICA',
  [TipoComprobante.NOTA_DEBITO]: 'NOTA DE DÉBITO ELECTRÓNICA',
};

const DOCUMENTOS: Record<string, string> = { '1': 'DNI', '6': 'RUC', '4': 'C.E.', '7': 'PASAPORTE', '0': 'DOC.' };
const UNIDADES: Record<string, string> = { NIU: 'UND', ZZ: 'SERV' };

/** "1299.8" → "1,299.80" (sin pasar por number). */
export function formatearMonto(valor: Decimal): string {
  const [entero, dec2] = aTexto2(valor).split('.') as [string, string];
  const negativo = entero.startsWith('-');
  const digitos = negativo ? entero.slice(1) : entero;
  const conComas = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negativo ? '-' : ''}${conComas}.${dec2}`;
}

/** Valor unitario con hasta 4 decimales y separador de miles ("1000" → "1,000.00"). */
function formatearUnitario(valor: Decimal): string {
  const [entero, decimales] = aTextoHasta(valor, 4).split('.') as [string, string];
  return `${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimales}`;
}

export function contenidoQr(c: Comprobante): string {
  return [
    c.empresa.ruc,
    c.tipo,
    c.serie,
    String(c.numero),
    aTexto2(c.totales.igv),
    aTexto2(c.totales.importeTotal),
    c.fechaEmision,
    c.cliente.tipoDoc,
    c.cliente.numeroDoc,
  ].join('|') + '|';
}

function fechaPeru(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

function clienteSinIdentificar(c: Comprobante): boolean {
  return c.cliente.tipoDoc === '0' || !c.cliente.numeroDoc.trim() || c.cliente.numeroDoc === '-';
}

interface Lineas {
  emisor: string[];
  datos: [string, string][];
  referencia: [string, string][];
  totales: [string, string][];
  cuotas: [string, string, string][];
}

/** Arma los textos una sola vez; ambos formatos los dibujan a su manera. */
function prepararTextos(d: DatosPdf): Lineas {
  const c = d.comprobante;
  const e = c.empresa;
  const dir = e.direccion;
  const emisor = [
    ...(d.marca ? [d.marca] : e.nombreComercial ? [e.nombreComercial] : []),
    `${dir.direccion}${dir.urbanizacion ? `, ${dir.urbanizacion}` : ''}`,
    `${dir.distrito} - ${dir.provincia} - ${dir.departamento}`,
  ];
  const datos: [string, string][] = [['Fecha de emisión', `${fechaPeru(c.fechaEmision)} ${c.horaEmision}`]];
  if (clienteSinIdentificar(c)) {
    datos.push(['Cliente', c.cliente.nombre || 'CLIENTES VARIOS']);
  } else {
    datos.push([DOCUMENTOS[c.cliente.tipoDoc] ?? 'Documento', c.cliente.numeroDoc]);
    datos.push([c.tipo === TipoComprobante.FACTURA ? 'Razón social' : 'Cliente', c.cliente.nombre]);
    if (c.cliente.direccion) datos.push(['Dirección', c.cliente.direccion]);
  }
  datos.push(['Moneda', 'SOLES (PEN)']);
  if (c.tipo === TipoComprobante.FACTURA) datos.push(['Forma de pago', c.formaPago.tipo === 'CREDITO' ? 'CRÉDITO' : 'CONTADO']);

  const referencia: [string, string][] = [];
  const nota = notaDe(c);
  if (nota) {
    const r = nota.referencia;
    const motivos = c.notaCredito ? MOTIVOS_NOTA_CREDITO : MOTIVOS_NOTA_DEBITO;
    referencia.push(['Documento que modifica', `${TITULOS[r.tipo] ?? r.tipo} ${idComprobanteLegible(r.serie, r.numero)}`]);
    referencia.push(['Motivo', `${nota.motivoCodigo} - ${motivos[nota.motivoCodigo] ?? ''}`]);
    referencia.push(['Sustento', nota.motivoDescripcion]);
  }

  const t = c.totales;
  const totales: [string, string][] = [];
  if (t.descuentoGlobal) totales.push(['Descuento global (sin IGV)', `-${formatearMonto(t.descuentoGlobal.monto)}`]);
  if (!t.gravado.isZero()) totales.push(['Op. gravadas', formatearMonto(t.gravado)]);
  if (!t.exonerado.isZero()) totales.push(['Op. exoneradas', formatearMonto(t.exonerado)]);
  if (!t.inafecto.isZero()) totales.push(['Op. inafectas', formatearMonto(t.inafecto)]);
  const tasa = c.items.find((i) => !i.porcentajeIgv.isZero())?.porcentajeIgv;
  totales.push([`IGV${tasa ? ` (${tasa.toString()}%)` : ''}`, formatearMonto(t.igv)]);
  totales.push(['IMPORTE TOTAL S/', formatearMonto(t.importeTotal)]);

  const cuotas: [string, string, string][] =
    c.formaPago.tipo === 'CREDITO'
      ? c.formaPago.cuotas.map((q, i) => [`Cuota ${String(i + 1).padStart(3, '0')}`, fechaPeru(q.fechaVencimiento), formatearMonto(dec(q.monto))])
      : [];
  return { emisor, datos, referencia, totales, cuotas };
}

function leyenda(c: Comprobante): string {
  return `Representación impresa de la ${TITULOS[c.tipo]}. Consulte su validez en www.sunat.gob.pe`;
}

function marcaDeAgua(doc: PDFKit.PDFDocument, texto: string, ancho: number, alto: number, tamano: number): void {
  doc.save();
  doc.fillColor('#d32f2f').opacity(0.18).fontSize(tamano).font('Helvetica-Bold');
  doc.rotate(-35, { origin: [ancho / 2, alto / 2] });
  doc.text(texto, 0, alto / 2 - tamano / 2, { width: ancho, align: 'center' });
  doc.restore();
  doc.opacity(1).fillColor('black');
}

function avisos(d: DatosPdf): string[] {
  const r: string[] = [];
  if (d.ambiente === 'BETA') r.push('PRUEBA - SIN VALOR LEGAL');
  if (d.estado === 'ANULADO') r.push('ANULADO');
  return r;
}

function aBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((ok, mal) => {
    const partes: Buffer[] = [];
    doc.on('data', (p: Buffer) => partes.push(p));
    doc.on('end', () => ok(Buffer.concat(partes)));
    doc.on('error', mal);
    doc.end();
  });
}

export async function generarPdf(d: DatosPdf, formato: FormatoPdf): Promise<Buffer> {
  if (d.estado === 'RECHAZADO') throw new ErrorPdf('Un comprobante RECHAZADO por SUNAT no tiene validez y no se imprime.');
  if (!d.hashFirma) throw new ErrorPdf('El comprobante aún no está firmado.');
  if (!TITULOS[d.comprobante.tipo]) throw new ErrorPdf(`Tipo de comprobante sin formato de impresión: ${d.comprobante.tipo}`);
  const qr = await QRCode.toBuffer(contenidoQr(d.comprobante), { errorCorrectionLevel: 'Q', type: 'png', margin: 1, scale: 6 });
  const textos = prepararTextos(d);
  if (formato === 'A4') return dibujarA4(d, textos, qr);
  // Ticket: primero se mide el alto real y luego se dibuja en una página de ese alto.
  const alto = dibujarTicket(nuevoDoc([MM80, 5000]), d, textos, qr);
  const doc = nuevoDoc([MM80, alto + 12]);
  dibujarTicket(doc, d, textos, qr);
  return aBuffer(doc);
}

function nuevoDoc(size: [number, number] | 'A4'): PDFKit.PDFDocument {
  return new PDFDocument({ size, margin: 0, autoFirstPage: true, info: { Producer: 'Facturador SUNAT', Creator: 'Facturador SUNAT' } });
}

// ---------------------------------------------------------------------------
// A4
// ---------------------------------------------------------------------------

const A4 = { ancho: 595.28, alto: 841.89, margen: 36 };

async function dibujarA4(d: DatosPdf, t: Lineas, qr: Buffer): Promise<Buffer> {
  const c = d.comprobante;
  const doc = nuevoDoc('A4');
  const izq = A4.margen;
  const der = A4.ancho - A4.margen;
  const anchoUtil = der - izq;
  const fondo = A4.alto - A4.margen;
  const decorarPagina = () => avisos(d).forEach((a, i) => marcaDeAgua(doc, a, A4.ancho, A4.alto + i * 160, 54));
  decorarPagina();

  // Encabezado: emisor a la izquierda, recuadro RUC/título/número a la derecha.
  const anchoCaja = 200;
  const xCaja = der - anchoCaja;
  let y = A4.margen;
  let xTexto = izq;
  if (d.logo) {
    try {
      doc.image(d.logo, izq, y, { fit: [80, 60] });
      xTexto = izq + 90;
    } catch {
      // Logo inválido: se imprime sin logo.
    }
  }
  const anchoEmisor = xCaja - 12 - xTexto;
  doc.font('Helvetica-Bold').fontSize(12).text(c.empresa.razonSocial, xTexto, y, { width: anchoEmisor });
  doc.font('Helvetica').fontSize(8.5);
  for (const linea of t.emisor) doc.text(linea, { width: anchoEmisor });
  const finEmisor = doc.y;

  doc.lineWidth(1).roundedRect(xCaja, y, anchoCaja, 72, 4).stroke();
  doc.font('Helvetica-Bold').fontSize(11).text(`R.U.C. ${c.empresa.ruc}`, xCaja, y + 10, { width: anchoCaja, align: 'center' });
  doc.fontSize(10).text(TITULOS[c.tipo]!, xCaja, y + 28, { width: anchoCaja, align: 'center' });
  doc.fontSize(12).text(idComprobanteLegible(c.serie, c.numero), xCaja, y + 48, { width: anchoCaja, align: 'center' });
  y = Math.max(finEmisor, y + 72) + 14;
  // Aviso también en horizontal (además de la marca de agua), fácil de leer.
  for (const aviso of avisos(d)) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#d32f2f').text(`*** ${aviso} ***`, izq, y, { width: anchoUtil, align: 'center' });
    doc.fillColor('black');
    y = doc.y + 6;
  }

  // Datos del comprobante y del cliente.
  const pares = [...t.datos, ...t.referencia];
  doc.fontSize(9);
  for (const [k, v] of pares) {
    doc.font('Helvetica-Bold').text(`${k}:`, izq, y, { width: 120 });
    doc.font('Helvetica').text(v, izq + 125, y, { width: anchoUtil - 125 });
    y = Math.max(doc.y, y + 12) + 2;
  }
  y += 8;

  // Tabla de ítems.
  const cols = [
    { titulo: 'CANT.', ancho: 42, alin: 'right' as const },
    { titulo: 'UNID.', ancho: 34, alin: 'center' as const },
    { titulo: 'CÓDIGO', ancho: 52, alin: 'left' as const },
    { titulo: 'DESCRIPCIÓN', ancho: 0, alin: 'left' as const },
    { titulo: 'V. UNIT.', ancho: 62, alin: 'right' as const },
    { titulo: 'P. UNIT.', ancho: 58, alin: 'right' as const },
    { titulo: 'IMPORTE', ancho: 66, alin: 'right' as const },
  ];
  cols[3]!.ancho = anchoUtil - cols.reduce((s, col) => s + col.ancho, 0);
  const encabezadoTabla = () => {
    doc.rect(izq, y, anchoUtil, 16).fill('#eeeeee').fillColor('black');
    let x = izq;
    doc.font('Helvetica-Bold').fontSize(7.5);
    for (const col of cols) {
      doc.text(col.titulo, x + 3, y + 4, { width: col.ancho - 6, align: col.alin });
      x += col.ancho;
    }
    y += 18;
  };
  encabezadoTabla();
  doc.font('Helvetica').fontSize(8);
  for (const it of c.items) {
    const celdas = [
      it.cantidad.toString(),
      UNIDADES[it.unidad] ?? it.unidad,
      it.codigo ?? '',
      it.descripcion,
      formatearUnitario(it.valorUnitario),
      formatearMonto(it.precioUnitario),
      formatearMonto(it.total),
    ];
    const alto = Math.max(...celdas.map((txt, i) => doc.heightOfString(txt, { width: cols[i]!.ancho - 6 }))) + 6;
    if (y + alto > fondo - 40) {
      doc.addPage();
      decorarPagina();
      y = A4.margen;
      encabezadoTabla();
      doc.font('Helvetica').fontSize(8);
    }
    let x = izq;
    celdas.forEach((txt, i) => {
      doc.text(txt, x + 3, y + 3, { width: cols[i]!.ancho - 6, align: cols[i]!.alin });
      x += cols[i]!.ancho;
    });
    y += alto;
    doc.moveTo(izq, y).lineTo(der, y).lineWidth(0.3).strokeColor('#bbbbbb').stroke().strokeColor('black');
  }
  y += 10;

  // Bloque final: QR + leyendas a la izquierda, totales a la derecha. Si no entra, nueva página.
  const altoCuotas = t.cuotas.length ? 16 + t.cuotas.length * 12 : 0;
  const altoFinal = Math.max(t.totales.length * 14 + 40, 130) + altoCuotas + 50;
  if (y + altoFinal > fondo) {
    doc.addPage();
    decorarPagina();
    y = A4.margen;
  }
  const xTot = der - 220;
  let yTot = y;
  for (const [k, v] of t.totales) {
    const final = k.startsWith('IMPORTE');
    doc.font(final ? 'Helvetica-Bold' : 'Helvetica').fontSize(final ? 10 : 9);
    doc.text(k, xTot, yTot, { width: 130, align: 'right' });
    doc.text(v, xTot + 135, yTot, { width: 85, align: 'right' });
    yTot += final ? 16 : 13;
  }
  doc.font('Helvetica').fontSize(8.5).text(montoEnLetras(c.totales.importeTotal), xTot - 40, yTot + 4, { width: 260, align: 'right' });
  yTot = doc.y;

  doc.image(qr, izq, y, { width: 100 });
  doc.font('Helvetica').fontSize(7.5);
  doc.text(`Código hash: ${d.hashFirma}`, izq + 110, y + 4, { width: xTot - izq - 130 });
  doc.text(leyenda(c), izq + 110, doc.y + 4, { width: xTot - izq - 130 });
  y = Math.max(y + 104, yTot, doc.y) + 10;

  if (t.cuotas.length) {
    doc.font('Helvetica-Bold').fontSize(9).text('Información del crédito', izq, y);
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(8.5);
    for (const [n, f, m] of t.cuotas) {
      doc.text(`${n}   vence ${f}   S/ ${m}`, izq, y);
      y = doc.y + 1;
    }
  }
  return aBuffer(doc);
}

// ---------------------------------------------------------------------------
// Ticket 80 mm
// ---------------------------------------------------------------------------

const MM80 = 226.77; // 80 mm en puntos
const T = { margen: 10 };

/** Dibuja el ticket y devuelve la altura usada (para el segundo pase). */
function dibujarTicket(doc: PDFKit.PDFDocument, d: DatosPdf, t: Lineas, qr: Buffer): number {
  const c = d.comprobante;
  const ancho = MM80 - T.margen * 2;
  const x = T.margen;
  let y = T.margen;
  const centrado = (txt: string, fuente = 'Helvetica', tam = 7.5) => {
    doc.font(fuente).fontSize(tam).text(txt, x, y, { width: ancho, align: 'center' });
    y = doc.y + 1;
  };
  const separador = () => {
    y += 3;
    doc.moveTo(x, y).lineTo(x + ancho, y).dash(2, { space: 2 }).lineWidth(0.5).stroke().undash();
    y += 5;
  };
  const par = (k: string, v: string, negrita = false) => {
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(negrita ? 8.5 : 7.5);
    doc.text(k, x, y, { width: ancho * 0.6 });
    const yk = doc.y;
    doc.text(v, x + ancho * 0.6, y, { width: ancho * 0.4, align: 'right' });
    y = Math.max(yk, doc.y) + 1;
  };

  if (d.logo) {
    try {
      doc.image(d.logo, x + ancho / 2 - 35, y, { fit: [70, 45] });
      y += 50;
    } catch {
      // sin logo
    }
  }
  centrado(c.empresa.razonSocial, 'Helvetica-Bold', 9);
  for (const linea of t.emisor) centrado(linea);
  centrado(`R.U.C. ${c.empresa.ruc}`, 'Helvetica-Bold', 8.5);
  separador();
  centrado(TITULOS[c.tipo]!, 'Helvetica-Bold', 9);
  centrado(idComprobanteLegible(c.serie, c.numero), 'Helvetica-Bold', 10);
  separador();
  for (const [k, v] of [...t.datos, ...t.referencia]) {
    doc.font('Helvetica-Bold').fontSize(7.5).text(`${k}: `, x, y, { width: ancho, continued: true }).font('Helvetica').text(v);
    y = doc.y + 1;
  }
  separador();
  for (const it of c.items) {
    doc.font('Helvetica').fontSize(7.5).text(it.descripcion, x, y, { width: ancho });
    y = doc.y;
    par(`${it.cantidad.toString()} ${UNIDADES[it.unidad] ?? it.unidad} x ${formatearMonto(it.precioUnitario)}`, formatearMonto(it.total));
    y += 2;
  }
  separador();
  for (const [k, v] of t.totales) par(k, v, k.startsWith('IMPORTE'));
  y += 2;
  centrado(montoEnLetras(c.totales.importeTotal), 'Helvetica', 7);
  if (t.cuotas.length) {
    separador();
    centrado('Información del crédito', 'Helvetica-Bold', 7.5);
    for (const [n, f, m] of t.cuotas) par(`${n} (vence ${f})`, m);
  }
  separador();
  doc.image(qr, x + ancho / 2 - 45, y, { width: 90 });
  y += 94;
  centrado(`Código hash: ${d.hashFirma}`, 'Helvetica', 6.5);
  centrado(leyenda(c), 'Helvetica', 6.5);
  for (const a of avisos(d)) centrado(`*** ${a} ***`, 'Helvetica-Bold', 9);
  return y;
}
