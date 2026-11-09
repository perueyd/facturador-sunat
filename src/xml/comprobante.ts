/**
 * XML UBL 2.1 de factura (01), boleta (03), nota de crédito (07) y nota de débito (08).
 */
import { Decimal, aTextoHasta, dec, redondear } from '../dinero.js';
import {
  LEYENDA_MONTO_EN_LETRAS,
  TIPO_OPERACION_VENTA_INTERNA,
  TRIBUTO_POR_AFECTACION,
} from '../catalogos.js';
import { montoEnLetras } from '../calculos/monto-en-letras.js';
import {
  Afectacion,
  TipoComprobante,
  idComprobante,
  type Comprobante,
  type ItemCalculado,
} from '../tipos.js';
import { crearDocumento, el, emisor, firmaReferencia, monto, terminar, type Nodo } from './comun.js';

export function generarXmlComprobante(c: Comprobante, legible = false): string {
  switch (c.tipo) {
    case TipoComprobante.FACTURA:
    case TipoComprobante.BOLETA:
      return generarInvoice(c, legible);
    case TipoComprobante.NOTA_CREDITO:
      return generarNota(c, legible, 'credito');
    case TipoComprobante.NOTA_DEBITO:
      return generarNota(c, legible, 'debito');
    default:
      throw new Error(`Tipo de comprobante aún no soportado: ${c.tipo}`);
  }
}

function cabecera(doc: Nodo, c: Comprobante): void {
  el(doc, 'cbc:UBLVersionID', '2.1');
  el(doc, 'cbc:CustomizationID', '2.0');
  el(doc, 'cbc:ID', idComprobante(c.serie, c.numero));
  el(doc, 'cbc:IssueDate', c.fechaEmision);
  el(doc, 'cbc:IssueTime', c.horaEmision);
}

function leyendas(doc: Nodo, c: Comprobante): void {
  el(doc, 'cbc:Note', montoEnLetras(c.totales.importeTotal), { languageLocaleID: LEYENDA_MONTO_EN_LETRAS });
}

function receptor(doc: Nodo, c: Comprobante): void {
  const party = doc.ele('cac:AccountingCustomerParty').ele('cac:Party');
  el(party.ele('cac:PartyIdentification'), 'cbc:ID', c.cliente.numeroDoc, { schemeID: c.cliente.tipoDoc });
  const legal = party.ele('cac:PartyLegalEntity');
  el(legal, 'cbc:RegistrationName', c.cliente.nombre);
  if (c.cliente.direccion) {
    el(legal.ele('cac:RegistrationAddress').ele('cac:AddressLine'), 'cbc:Line', c.cliente.direccion);
  }
}

function formaPago(doc: Nodo, c: Comprobante): void {
  // SUNAT exige la forma de pago en facturas (desde 2021).
  if (c.tipo !== TipoComprobante.FACTURA) return;
  if (c.formaPago.tipo === 'CONTADO') {
    const t = doc.ele('cac:PaymentTerms');
    el(t, 'cbc:ID', 'FormaPago');
    el(t, 'cbc:PaymentMeansID', 'Contado');
    return;
  }
  const t = doc.ele('cac:PaymentTerms');
  el(t, 'cbc:ID', 'FormaPago');
  el(t, 'cbc:PaymentMeansID', 'Credito');
  monto(t, 'cbc:Amount', c.totales.importeTotal, c.moneda);
  c.formaPago.cuotas.forEach((q, i) => {
    const tq = doc.ele('cac:PaymentTerms');
    el(tq, 'cbc:ID', 'FormaPago');
    el(tq, 'cbc:PaymentMeansID', `Cuota${String(i + 1).padStart(3, '0')}`);
    monto(tq, 'cbc:Amount', dec(q.monto), c.moneda);
    el(tq, 'cbc:PaymentDueDate', q.fechaVencimiento);
  });
}

/** Descuento global que afecta la base imponible (catálogo 53, código 02). */
function descuentoGlobal(doc: Nodo, c: Comprobante): void {
  const d = c.totales.descuentoGlobal;
  if (!d) return;
  const a = doc.ele('cac:AllowanceCharge');
  el(a, 'cbc:ChargeIndicator', 'false');
  el(a, 'cbc:AllowanceChargeReasonCode', '02', {
    listAgencyName: 'PE:SUNAT', listName: 'Cargo/descuento', listURI: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo53',
  });
  // El factor es opcional; si va, SUNAT exige base × factor = monto (± 1). Con 5 decimales
  // no siempre se cumple en montos grandes, así que solo se informa cuando lo reproduce.
  const factor = redondear(d.monto.div(d.base), 5);
  if (factor.gt(0) && d.base.times(factor).minus(d.monto).abs().lte(1)) el(a, 'cbc:MultiplierFactorNumeric', factor.toFixed(5));
  monto(a, 'cbc:Amount', d.monto, c.moneda);
  monto(a, 'cbc:BaseAmount', d.base, c.moneda);
}

function totalImpuestos(doc: Nodo, c: Comprobante): void {
  const t = c.totales;
  const tt = doc.ele('cac:TaxTotal');
  monto(tt, 'cbc:TaxAmount', t.igv, c.moneda);
  const subtotal = (afectacion: Afectacion, base: Decimal, impuesto: Decimal) => {
    const s = tt.ele('cac:TaxSubtotal');
    monto(s, 'cbc:TaxableAmount', base, c.moneda);
    monto(s, 'cbc:TaxAmount', impuesto, c.moneda);
    const trib = TRIBUTO_POR_AFECTACION[afectacion];
    const esquema = s.ele('cac:TaxCategory').ele('cac:TaxScheme');
    el(esquema, 'cbc:ID', trib.id);
    el(esquema, 'cbc:Name', trib.nombre);
    el(esquema, 'cbc:TaxTypeCode', trib.codigo);
  };
  const hay = (a: Afectacion) => c.items.some((i) => i.afectacion === a);
  if (hay(Afectacion.GRAVADO)) subtotal(Afectacion.GRAVADO, t.gravado, t.igv);
  if (hay(Afectacion.EXONERADO)) subtotal(Afectacion.EXONERADO, t.exonerado, new Decimal(0));
  if (hay(Afectacion.INAFECTO)) subtotal(Afectacion.INAFECTO, t.inafecto, new Decimal(0));
}

function totalesMonetarios(doc: Nodo, c: Comprobante, nombre = 'cac:LegalMonetaryTotal'): void {
  const m = doc.ele(nombre);
  monto(m, 'cbc:LineExtensionAmount', c.totales.valorVenta, c.moneda);
  monto(m, 'cbc:TaxInclusiveAmount', c.totales.precioVenta, c.moneda);
  monto(m, 'cbc:PayableAmount', c.totales.importeTotal, c.moneda);
}

function linea(doc: Nodo, c: Comprobante, item: ItemCalculado, indice: number, nombreLinea: string, nombreCantidad: string): void {
  const l = doc.ele(`cac:${nombreLinea}`);
  el(l, 'cbc:ID', String(indice + 1));
  el(l, `cbc:${nombreCantidad}`, item.cantidad.toString(), { unitCode: item.unidad });
  monto(l, 'cbc:LineExtensionAmount', item.valorVenta, c.moneda);

  const precio = l.ele('cac:PricingReference').ele('cac:AlternativeConditionPrice');
  el(precio, 'cbc:PriceAmount', aTextoHasta(item.precioUnitario), { currencyID: c.moneda });
  el(precio, 'cbc:PriceTypeCode', '01'); // 01 = precio unitario con impuestos

  const tt = l.ele('cac:TaxTotal');
  monto(tt, 'cbc:TaxAmount', item.igv, c.moneda);
  const s = tt.ele('cac:TaxSubtotal');
  monto(s, 'cbc:TaxableAmount', item.valorVenta, c.moneda);
  monto(s, 'cbc:TaxAmount', item.igv, c.moneda);
  const cat = s.ele('cac:TaxCategory');
  el(cat, 'cbc:Percent', item.porcentajeIgv.toFixed(2));
  el(cat, 'cbc:TaxExemptionReasonCode', item.afectacion);
  const trib = TRIBUTO_POR_AFECTACION[item.afectacion];
  const esquema = cat.ele('cac:TaxScheme');
  el(esquema, 'cbc:ID', trib.id);
  el(esquema, 'cbc:Name', trib.nombre);
  el(esquema, 'cbc:TaxTypeCode', trib.codigo);

  const art = l.ele('cac:Item');
  el(art, 'cbc:Description', item.descripcion);
  if (item.codigo) el(art.ele('cac:SellersItemIdentification'), 'cbc:ID', item.codigo);

  el(l.ele('cac:Price'), 'cbc:PriceAmount', aTextoHasta(item.valorUnitario), { currencyID: c.moneda });
}

function generarInvoice(c: Comprobante, legible: boolean): string {
  const doc = crearDocumento('invoice', 'Invoice', false);
  cabecera(doc, c);
  el(doc, 'cbc:InvoiceTypeCode', c.tipo, { listID: TIPO_OPERACION_VENTA_INTERNA });
  leyendas(doc, c);
  el(doc, 'cbc:DocumentCurrencyCode', c.moneda);
  firmaReferencia(doc, c.empresa);
  emisor(doc, c.empresa);
  receptor(doc, c);
  formaPago(doc, c);
  descuentoGlobal(doc, c);
  totalImpuestos(doc, c);
  totalesMonetarios(doc, c);
  c.items.forEach((item, i) => linea(doc, c, item, i, 'InvoiceLine', 'InvoicedQuantity'));
  return terminar(doc, legible);
}

/**
 * Nota de crédito (CreditNote) o de débito (DebitNote): igual estructura, salvo el nombre de la raíz,
 * de las líneas (CreditNoteLine/CreditedQuantity o DebitNoteLine/DebitedQuantity) y del total, que
 * en la de débito es RequestedMonetaryTotal (esquema OASIS UBL 2.1 DebitNote).
 */
function generarNota(c: Comprobante, legible: boolean, clase: 'credito' | 'debito'): string {
  const nc = clase === 'credito' ? c.notaCredito : c.notaDebito;
  if (!nc) throw new Error(`La nota de ${clase === 'credito' ? 'crédito' : 'débito'} necesita el comprobante de referencia y el motivo.`);
  const ref = idComprobante(nc.referencia.serie, nc.referencia.numero);

  const doc = clase === 'credito' ? crearDocumento('creditNote', 'CreditNote', false) : crearDocumento('debitNote', 'DebitNote', false);
  cabecera(doc, c);
  leyendas(doc, c);
  el(doc, 'cbc:DocumentCurrencyCode', c.moneda);
  const disc = doc.ele('cac:DiscrepancyResponse');
  el(disc, 'cbc:ReferenceID', ref);
  el(disc, 'cbc:ResponseCode', nc.motivoCodigo);
  el(disc, 'cbc:Description', nc.motivoDescripcion);
  const br = doc.ele('cac:BillingReference').ele('cac:InvoiceDocumentReference');
  el(br, 'cbc:ID', ref);
  el(br, 'cbc:DocumentTypeCode', nc.referencia.tipo);
  firmaReferencia(doc, c.empresa);
  emisor(doc, c.empresa);
  receptor(doc, c);
  totalImpuestos(doc, c);
  if (clase === 'credito') {
    totalesMonetarios(doc, c);
    c.items.forEach((item, i) => linea(doc, c, item, i, 'CreditNoteLine', 'CreditedQuantity'));
  } else {
    totalesMonetarios(doc, c, 'cac:RequestedMonetaryTotal');
    c.items.forEach((item, i) => linea(doc, c, item, i, 'DebitNoteLine', 'DebitedQuantity'));
  }
  return terminar(doc, legible);
}
