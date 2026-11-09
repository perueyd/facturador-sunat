/**
 * XML del Resumen Diario de boletas (RC) y de la Comunicación de Baja (RA).
 * Ambos usan esquemas propios de SUNAT (basados en UBL 2.0) y se envían con
 * `sendSummary`; SUNAT responde con un ticket que luego se consulta.
 *
 * ⚠️ Plazos (por confirmar en la norma vigente; ver docs/PLAN.md):
 *   - Resumen diario: hasta 7 días calendario desde la emisión de las boletas.
 *   - Comunicación de baja de facturas: hasta el 7.º día calendario.
 *   - R.S. 000048-2026/SUNAT podría cambiar estas reglas desde el 1-ene-2027.
 */
import type { Decimal } from '../dinero.js';
import type { CondicionResumen } from '../catalogos.js';
import { Afectacion, TipoComprobante, idComprobante, notaDe, type Comprobante, type Empresa } from '../tipos.js';
import { crearDocumento, el, emisorResumen, firmaReferencia, monto, terminar } from './comun.js';

export interface LineaResumen {
  comprobante: Comprobante;
  condicion: CondicionResumen;
}

export interface ResumenDiario {
  empresa: Empresa;
  /** Correlativo del resumen dentro del día de generación (1, 2, 3…). */
  correlativo: number;
  /** Fecha de emisión de las boletas resumidas (AAAA-MM-DD). */
  fechaReferencia: string;
  /** Fecha en que se genera el resumen (AAAA-MM-DD). */
  fechaGeneracion: string;
  lineas: LineaResumen[];
}

export interface LineaBaja {
  tipo: TipoComprobante;
  serie: string;
  numero: number;
  motivo: string;
}

export interface ComunicacionBaja {
  empresa: Empresa;
  correlativo: number;
  /** Fecha de emisión de los comprobantes que se dan de baja. */
  fechaReferencia: string;
  /** Fecha en que se genera la comunicación. */
  fechaGeneracion: string;
  lineas: LineaBaja[];
}

/** "RC-20261023-1" */
export function idResumen(prefijo: 'RC' | 'RA', fechaGeneracion: string, correlativo: number): string {
  if (!Number.isInteger(correlativo) || correlativo < 1 || correlativo > 99999) {
    throw new Error('El correlativo del resumen debe estar entre 1 y 99999.');
  }
  return `${prefijo}-${fechaGeneracion.replaceAll('-', '')}-${correlativo}`;
}

export function generarXmlResumenDiario(r: ResumenDiario, legible = false): string {
  if (r.lineas.length === 0) throw new Error('El resumen diario no tiene boletas.');
  if (r.lineas.length > 500) throw new Error('Máximo 500 líneas por resumen; divídelo en varios.'); // ⚠️ confirmar límite vigente
  for (const { comprobante: c } of r.lineas) {
    const esBoleta = c.tipo === TipoComprobante.BOLETA;
    const esNotaDeBoleta = notaDe(c)?.referencia.tipo === TipoComprobante.BOLETA;
    if (!esBoleta && !esNotaDeBoleta) {
      throw new Error(`${idComprobante(c.serie, c.numero)}: el resumen diario solo admite boletas y sus notas.`);
    }
    if (c.fechaEmision !== r.fechaReferencia) {
      throw new Error(`${idComprobante(c.serie, c.numero)}: todas las boletas del resumen deben ser del mismo día.`);
    }
  }

  const moneda = 'PEN';
  const doc = crearDocumento('summary', 'SummaryDocuments', true);
  el(doc, 'cbc:UBLVersionID', '2.0');
  el(doc, 'cbc:CustomizationID', '1.1');
  el(doc, 'cbc:ID', idResumen('RC', r.fechaGeneracion, r.correlativo));
  el(doc, 'cbc:ReferenceDate', r.fechaReferencia);
  el(doc, 'cbc:IssueDate', r.fechaGeneracion);
  firmaReferencia(doc, r.empresa);
  emisorResumen(doc, r.empresa);

  r.lineas.forEach(({ comprobante: c, condicion }, i) => {
    const l = doc.ele('sac:SummaryDocumentsLine');
    el(l, 'cbc:LineID', String(i + 1));
    el(l, 'cbc:DocumentTypeCode', c.tipo);
    el(l, 'cbc:ID', idComprobante(c.serie, c.numero));
    const cli = l.ele('cac:AccountingCustomerParty');
    el(cli, 'cbc:CustomerAssignedAccountID', c.cliente.numeroDoc);
    el(cli, 'cbc:AdditionalAccountID', c.cliente.tipoDoc);
    const nota = notaDe(c);
    if (nota) {
      const ref = l.ele('cac:BillingReference').ele('cac:InvoiceDocumentReference');
      el(ref, 'cbc:ID', idComprobante(nota.referencia.serie, nota.referencia.numero));
      el(ref, 'cbc:DocumentTypeCode', nota.referencia.tipo);
    }
    el(l.ele('cac:Status'), 'cbc:ConditionCode', condicion);
    monto(l, 'sac:TotalAmount', c.totales.importeTotal, moneda);
    const pagos: [Afectacion, Decimal, string][] = [
      [Afectacion.GRAVADO, c.totales.gravado, '01'],
      [Afectacion.EXONERADO, c.totales.exonerado, '02'],
      [Afectacion.INAFECTO, c.totales.inafecto, '03'],
    ];
    for (const [afectacion, valor, codigo] of pagos) {
      // La base gravada siempre se informa; las demás solo si existen.
      if (afectacion !== Afectacion.GRAVADO && valor.isZero()) continue;
      const bp = l.ele('sac:BillingPayment');
      monto(bp, 'cbc:PaidAmount', valor, moneda);
      el(bp, 'cbc:InstructionID', codigo);
    }
    const tt = l.ele('cac:TaxTotal');
    monto(tt, 'cbc:TaxAmount', c.totales.igv, moneda);
    const s = tt.ele('cac:TaxSubtotal');
    monto(s, 'cbc:TaxAmount', c.totales.igv, moneda);
    const esquema = s.ele('cac:TaxCategory').ele('cac:TaxScheme');
    el(esquema, 'cbc:ID', '1000');
    el(esquema, 'cbc:Name', 'IGV');
    el(esquema, 'cbc:TaxTypeCode', 'VAT');
  });
  return terminar(doc, legible);
}

export function generarXmlComunicacionBaja(b: ComunicacionBaja, legible = false): string {
  if (b.lineas.length === 0) throw new Error('La comunicación de baja no tiene comprobantes.');
  for (const l of b.lineas) {
    if (!l.motivo.trim()) throw new Error(`${idComprobante(l.serie, l.numero)}: falta el motivo de la baja.`);
    if (l.tipo === TipoComprobante.BOLETA) {
      throw new Error(`${idComprobante(l.serie, l.numero)}: las boletas se anulan en el resumen diario, no con comunicación de baja.`);
    }
  }
  const doc = crearDocumento('voided', 'VoidedDocuments', true);
  el(doc, 'cbc:UBLVersionID', '2.0');
  el(doc, 'cbc:CustomizationID', '1.0');
  el(doc, 'cbc:ID', idResumen('RA', b.fechaGeneracion, b.correlativo));
  el(doc, 'cbc:ReferenceDate', b.fechaReferencia);
  el(doc, 'cbc:IssueDate', b.fechaGeneracion);
  firmaReferencia(doc, b.empresa);
  emisorResumen(doc, b.empresa);
  b.lineas.forEach((linea, i) => {
    const l = doc.ele('sac:VoidedDocumentsLine');
    el(l, 'cbc:LineID', String(i + 1));
    el(l, 'cbc:DocumentTypeCode', linea.tipo);
    el(l, 'sac:DocumentSerialID', linea.serie);
    el(l, 'sac:DocumentNumberID', String(linea.numero));
    el(l, 'sac:VoidReasonDescription', linea.motivo);
  });
  return terminar(doc, legible);
}

