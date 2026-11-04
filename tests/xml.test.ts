import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { prepararComprobante, type SolicitudComprobante } from '../src/comprobantes/preparar.js';
import { CondicionResumen } from '../src/catalogos.js';
import { generarXmlComprobante } from '../src/xml/comprobante.js';
import { nombreArchivoComprobante } from '../src/xml/nombres.js';
import { generarXmlComunicacionBaja, generarXmlResumenDiario, idResumen } from '../src/xml/resumenes.js';
import { Afectacion, TipoComprobante, type Comprobante } from '../src/tipos.js';
import { TipoDocIdentidad } from '../src/validaciones/documentos.js';
import { RUC_EMPRESA, contextoPrueba, empresaPrueba, item, boletaFija as solicitudBoleta, facturaFija as solicitudFactura, validarContraXsd } from './ayudantes.js';

function armar(s: SolicitudComprobante, numero = 1, ctx = contextoPrueba): Comprobante {
  const r = prepararComprobante(s, ctx);
  if (!r.ok) throw new Error(r.errores.join('\n'));
  return { ...r.comprobante, numero };
}

/** Lee un valor del XML con XPath (ignorando prefijos de namespace). */
function xpath(xml: string, ruta: string): string {
  const expr = ruta
    .split('/')
    .map((p) => (p === '' ? '' : p.replace(/^(\w+:)?([\w]+)(\[.*\])?$/, "*[local-name()='$2']$3")))
    .join('/');
  return execFileSync('xmllint', ['--xpath', `string(${expr})`, '-'], { input: xml }).toString().replace(/\n$/, '');
}

function contar(xml: string, ruta: string): number {
  const expr = ruta.split('/').map((p) => (p === '' ? '' : `*[local-name()='${p.replace(/^\w+:/, '')}']`)).join('/');
  return Number(execFileSync('xmllint', ['--xpath', `count(${expr})`, '-'], { input: xml }).toString());
}

describe('factura (01)', () => {
  const c = armar(solicitudFactura(), 15);
  const xml = generarXmlComprobante(c);

  it('cumple el esquema oficial UBL 2.1', () => {
    expect(() => validarContraXsd(xml, 'UBL-Invoice-2.1.xsd')).not.toThrow();
  });

  it('control: el validador sí detecta un XML incorrecto', () => {
    const sinId = xml.replace('<cbc:ID>F001-15</cbc:ID>', '');
    expect(() => validarContraXsd(sinId, 'UBL-Invoice-2.1.xsd')).toThrow(/no cumple el esquema/);
  });

  it('cabecera', () => {
    expect(xpath(xml, '/Invoice/UBLVersionID')).toBe('2.1');
    expect(xpath(xml, '/Invoice/CustomizationID')).toBe('2.0');
    expect(xpath(xml, '/Invoice/ID')).toBe('F001-15');
    expect(xpath(xml, '/Invoice/IssueDate')).toBe('2026-10-20');
    expect(xpath(xml, '/Invoice/InvoiceTypeCode')).toBe('01');
    expect(xpath(xml, '/Invoice/InvoiceTypeCode/@listID')).toBe('0101');
    expect(xpath(xml, '/Invoice/Note')).toBe('SON MIL DOSCIENTOS NOVENTA Y NUEVE CON 80/100 SOLES');
    expect(xpath(xml, '/Invoice/DocumentCurrencyCode')).toBe('PEN');
  });

  it('emisor y cliente', () => {
    expect(xpath(xml, '/Invoice/AccountingSupplierParty/Party/PartyIdentification/ID')).toBe(RUC_EMPRESA);
    expect(xpath(xml, '/Invoice/AccountingSupplierParty/Party/PartyIdentification/ID/@schemeID')).toBe('6');
    expect(xpath(xml, '/Invoice/AccountingSupplierParty/Party/PartyLegalEntity/RegistrationAddress/ID')).toBe('150101');
    expect(xpath(xml, '/Invoice/AccountingCustomerParty/Party/PartyIdentification/ID/@schemeID')).toBe('6');
    expect(xpath(xml, '/Invoice/AccountingCustomerParty/Party/PartyLegalEntity/RegistrationName')).toBe('CLIENTE EMPRESA S.A.C.');
  });

  it('forma de pago al contado', () => {
    expect(xpath(xml, '/Invoice/PaymentTerms/ID')).toBe('FormaPago');
    expect(xpath(xml, '/Invoice/PaymentTerms/PaymentMeansID')).toBe('Contado');
  });

  it('totales e impuestos', () => {
    expect(xpath(xml, '/Invoice/TaxTotal/TaxAmount')).toBe('198.27');
    expect(xpath(xml, '/Invoice/TaxTotal/TaxSubtotal/TaxableAmount')).toBe('1101.53');
    expect(xpath(xml, '/Invoice/TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/ID')).toBe('1000');
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/LineExtensionAmount')).toBe('1101.53');
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/TaxInclusiveAmount')).toBe('1299.80');
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/PayableAmount')).toBe('1299.80');
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/PayableAmount/@currencyID')).toBe('PEN');
  });

  it('líneas', () => {
    expect(contar(xml, '/Invoice/InvoiceLine')).toBe(2);
    const l2 = '/Invoice/InvoiceLine[2]';
    expect(xpath(xml, `${l2}/InvoicedQuantity`)).toBe('2');
    expect(xpath(xml, `${l2}/InvoicedQuantity/@unitCode`)).toBe('NIU');
    expect(xpath(xml, `${l2}/LineExtensionAmount`)).toBe('101.53');
    expect(xpath(xml, `${l2}/PricingReference/AlternativeConditionPrice/PriceAmount`)).toBe('59.90');
    expect(xpath(xml, `${l2}/PricingReference/AlternativeConditionPrice/PriceTypeCode`)).toBe('01');
    expect(xpath(xml, `${l2}/TaxTotal/TaxAmount`)).toBe('18.27');
    expect(xpath(xml, `${l2}/TaxTotal/TaxSubtotal/TaxCategory/Percent`)).toBe('18.00');
    expect(xpath(xml, `${l2}/TaxTotal/TaxSubtotal/TaxCategory/TaxExemptionReasonCode`)).toBe('10');
    expect(xpath(xml, `${l2}/Price/PriceAmount`)).toBe('50.7627118644');
  });

  it('escapa caracteres especiales (&, comillas) sin romper el XML', () => {
    expect(xpath(xml, '/Invoice/InvoiceLine[2]/Item/Description')).toBe('Almohada & funda "premium"');
  });

  it('deja el lugar para la firma digital (fase 3)', () => {
    expect(xml).toContain('<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>');
    expect(xpath(xml, '/Invoice/Signature/DigitalSignatureAttachment/ExternalReference/URI')).toBe('#SignatureSP');
  });

  it('factura al crédito con cuotas', () => {
    const cc = armar(
      solicitudFactura({
        items: [item('1000.00')],
        formaPago: { tipo: 'CREDITO', cuotas: [{ monto: '600', fechaVencimiento: '2026-11-20' }, { monto: '400', fechaVencimiento: '2026-12-20' }] },
      }),
    );
    const x = generarXmlComprobante(cc);
    expect(() => validarContraXsd(x, 'UBL-Invoice-2.1.xsd')).not.toThrow();
    expect(xpath(x, '/Invoice/PaymentTerms[1]/PaymentMeansID')).toBe('Credito');
    expect(xpath(x, '/Invoice/PaymentTerms[1]/Amount')).toBe('1000.00');
    expect(xpath(x, '/Invoice/PaymentTerms[2]/PaymentMeansID')).toBe('Cuota001');
    expect(xpath(x, '/Invoice/PaymentTerms[2]/Amount')).toBe('600.00');
    expect(xpath(x, '/Invoice/PaymentTerms[3]/PaymentDueDate')).toBe('2026-12-20');
  });

  it('nombre de archivo SUNAT', () => {
    expect(nombreArchivoComprobante(RUC_EMPRESA, c.tipo, c.serie, c.numero)).toBe('20600000005-01-F001-15');
  });
});

describe('descuento global', () => {
  const c = armar(solicitudBoleta({ items: [item('354.00', '2')], descuentoGlobal: '50.00' }), 7);
  const xml = generarXmlComprobante(c);

  it('cumple el esquema oficial UBL 2.1 (AllowanceCharge en su lugar)', () => {
    expect(() => validarContraXsd(xml, 'UBL-Invoice-2.1.xsd')).not.toThrow();
  });

  it('descuento 02 con base bruta, y totales netos', () => {
    expect(xpath(xml, '/Invoice/AllowanceCharge/ChargeIndicator')).toBe('false');
    expect(xpath(xml, '/Invoice/AllowanceCharge/AllowanceChargeReasonCode')).toBe('02');
    expect(xpath(xml, '/Invoice/AllowanceCharge/Amount')).toBe('42.37');
    expect(xpath(xml, '/Invoice/AllowanceCharge/BaseAmount')).toBe('600.00');
    expect(xpath(xml, '/Invoice/AllowanceCharge/MultiplierFactorNumeric')).toBe('0.07062');
    expect(xpath(xml, '/Invoice/TaxTotal/TaxSubtotal/TaxableAmount')).toBe('557.63');
    expect(xpath(xml, '/Invoice/TaxTotal/TaxAmount')).toBe('100.37');
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/LineExtensionAmount')).toBe('557.63');
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/PayableAmount')).toBe('658.00');
    expect(contar(xml, '/Invoice/LegalMonetaryTotal/AllowanceTotalAmount')).toBe(0); // solo para descuentos que NO afectan la base
    // Las líneas conservan su valor sin descuento.
    expect(xpath(xml, '/Invoice/InvoiceLine/LineExtensionAmount')).toBe('600.00');
  });

  it('solo en facturas y boletas, menor que lo gravado y con hasta 2 decimales', () => {
    const errores = (extra: Partial<SolicitudComprobante>) => {
      const r = prepararComprobante(solicitudBoleta({ items: [item('100.00')], ...extra }), contextoPrueba);
      return r.ok ? [] : r.errores;
    };
    expect(errores({ descuentoGlobal: '100.00' })).toEqual([expect.stringMatching(/debe ser menor/)]);
    expect(errores({ descuentoGlobal: '0' })).toEqual([expect.stringMatching(/mayor que cero/)]);
    expect(errores({ descuentoGlobal: '1.005' })).toEqual([expect.stringMatching(/2 decimales/)]);
    expect(errores({ descuentoGlobal: '5.00', items: [item('100.00', '1', { afectacion: Afectacion.EXONERADO })] }))
      .toEqual(expect.arrayContaining([expect.stringMatching(/gravados/)]));
    expect(errores({
      descuentoGlobal: '5.00', tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01',
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo: '07', motivoDescripcion: 'x' },
    })).toEqual([expect.stringMatching(/nota de crédito/)]);
  });
});

describe('boleta (03)', () => {
  it('boleta con DNI cumple el esquema y no lleva forma de pago', () => {
    const xml = generarXmlComprobante(armar(solicitudBoleta(), 1));
    expect(() => validarContraXsd(xml, 'UBL-Invoice-2.1.xsd')).not.toThrow();
    expect(xpath(xml, '/Invoice/InvoiceTypeCode')).toBe('03');
    expect(xpath(xml, '/Invoice/AccountingCustomerParty/Party/PartyIdentification/ID')).toBe('12345678');
    expect(xpath(xml, '/Invoice/AccountingCustomerParty/Party/PartyIdentification/ID/@schemeID')).toBe('1');
    expect(contar(xml, '/Invoice/PaymentTerms')).toBe(0);
    expect(xpath(xml, '/Invoice/LegalMonetaryTotal/PayableAmount')).toBe('350.00');
  });

  it('boleta exonerada (taxi) usa el tributo 9997', () => {
    const ctx = { ...contextoPrueba, afectacionesPermitidas: [Afectacion.GRAVADO, Afectacion.EXONERADO] };
    const s = solicitudBoleta({
      items: [item('25.00', '1', { descripcion: 'Servicio de taxi', unidad: 'ZZ', afectacion: Afectacion.EXONERADO })],
    });
    const xml = generarXmlComprobante(armar(s, 1, ctx));
    expect(() => validarContraXsd(xml, 'UBL-Invoice-2.1.xsd')).not.toThrow();
    expect(xpath(xml, '/Invoice/TaxTotal/TaxAmount')).toBe('0.00');
    expect(xpath(xml, '/Invoice/TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/ID')).toBe('9997');
    expect(xpath(xml, '/Invoice/TaxTotal/TaxSubtotal/TaxCategory/TaxScheme/Name')).toBe('EXO');
    expect(xpath(xml, '/Invoice/InvoiceLine/TaxTotal/TaxSubtotal/TaxCategory/TaxExemptionReasonCode')).toBe('20');
    expect(xpath(xml, '/Invoice/InvoiceLine/TaxTotal/TaxSubtotal/TaxCategory/Percent')).toBe('0.00');
  });
});

describe('nota de crédito (07)', () => {
  const nc = armar(
    solicitudFactura({
      tipo: TipoComprobante.NOTA_CREDITO,
      serie: 'FC01',
      items: [item('59.90', '1', { descripcion: 'Almohada devuelta' })],
      notaCredito: {
        referencia: { tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 15 },
        motivoCodigo: '07',
        motivoDescripcion: 'Devolución de una almohada',
      },
    }),
    3,
  );
  const xml = generarXmlComprobante(nc);

  it('cumple el esquema oficial UBL 2.1', () => {
    expect(() => validarContraXsd(xml, 'UBL-CreditNote-2.1.xsd')).not.toThrow();
  });

  it('referencia al comprobante original y motivo', () => {
    expect(xpath(xml, '/CreditNote/ID')).toBe('FC01-3');
    expect(xpath(xml, '/CreditNote/DiscrepancyResponse/ReferenceID')).toBe('F001-15');
    expect(xpath(xml, '/CreditNote/DiscrepancyResponse/ResponseCode')).toBe('07');
    expect(xpath(xml, '/CreditNote/BillingReference/InvoiceDocumentReference/ID')).toBe('F001-15');
    expect(xpath(xml, '/CreditNote/BillingReference/InvoiceDocumentReference/DocumentTypeCode')).toBe('01');
    expect(xpath(xml, '/CreditNote/CreditNoteLine/CreditedQuantity')).toBe('1');
    expect(xpath(xml, '/CreditNote/LegalMonetaryTotal/PayableAmount')).toBe('59.90');
  });
});

describe('resumen diario (RC)', () => {
  const b1 = armar(solicitudBoleta(), 1);
  const b2 = armar(
    solicitudBoleta({ cliente: { tipoDoc: TipoDocIdentidad.SIN_DOCUMENTO, numeroDoc: '-', nombre: 'CLIENTES VARIOS' }, items: [item('80.00')] }),
    2,
  );
  const xml = generarXmlResumenDiario({
    empresa: empresaPrueba,
    correlativo: 1,
    fechaReferencia: '2026-10-20',
    fechaGeneracion: '2026-10-21',
    lineas: [
      { comprobante: b1, condicion: CondicionResumen.ADICIONAR },
      { comprobante: b2, condicion: CondicionResumen.ANULAR },
    ],
  });

  it('estructura', () => {
    expect(xpath(xml, '/SummaryDocuments/ID')).toBe('RC-20261021-1');
    expect(xpath(xml, '/SummaryDocuments/ReferenceDate')).toBe('2026-10-20');
    expect(xpath(xml, '/SummaryDocuments/IssueDate')).toBe('2026-10-21');
    expect(xpath(xml, '/SummaryDocuments/AccountingSupplierParty/CustomerAssignedAccountID')).toBe(RUC_EMPRESA);
    expect(contar(xml, '/SummaryDocuments/SummaryDocumentsLine')).toBe(2);
    const l1 = '/SummaryDocuments/SummaryDocumentsLine[1]';
    expect(xpath(xml, `${l1}/ID`)).toBe('B001-1');
    expect(xpath(xml, `${l1}/Status/ConditionCode`)).toBe('1');
    expect(xpath(xml, `${l1}/TotalAmount`)).toBe('350.00');
    expect(xpath(xml, `${l1}/BillingPayment/PaidAmount`)).toBe('296.61');
    expect(xpath(xml, `${l1}/BillingPayment/InstructionID`)).toBe('01');
    expect(xpath(xml, `${l1}/TaxTotal/TaxAmount`)).toBe('53.39');
    expect(xpath(xml, '/SummaryDocuments/SummaryDocumentsLine[2]/Status/ConditionCode')).toBe('3');
  });

  it('rechaza boletas de días distintos y facturas', () => {
    const otraFecha = armar(solicitudBoleta({ fechaEmision: '2026-10-19' }), 3);
    expect(() =>
      generarXmlResumenDiario({ empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-21', lineas: [{ comprobante: otraFecha, condicion: '1' }] }),
    ).toThrow(/mismo día/);
    const factura = armar(solicitudFactura(), 1);
    expect(() =>
      generarXmlResumenDiario({ empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-21', lineas: [{ comprobante: factura, condicion: '1' }] }),
    ).toThrow(/solo admite boletas/);
  });
});

describe('comunicación de baja (RA)', () => {
  it('estructura', () => {
    const xml = generarXmlComunicacionBaja({
      empresa: empresaPrueba,
      correlativo: 2,
      fechaReferencia: '2026-10-20',
      fechaGeneracion: '2026-10-22',
      lineas: [{ tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 15, motivo: 'Error en el RUC del cliente' }],
    });
    expect(xpath(xml, '/VoidedDocuments/ID')).toBe('RA-20261022-2');
    expect(xpath(xml, '/VoidedDocuments/VoidedDocumentsLine/DocumentTypeCode')).toBe('01');
    expect(xpath(xml, '/VoidedDocuments/VoidedDocumentsLine/DocumentSerialID')).toBe('F001');
    expect(xpath(xml, '/VoidedDocuments/VoidedDocumentsLine/DocumentNumberID')).toBe('15');
    expect(xpath(xml, '/VoidedDocuments/VoidedDocumentsLine/VoidReasonDescription')).toBe('Error en el RUC del cliente');
  });

  it('las boletas no se dan de baja aquí sino en el resumen diario', () => {
    expect(() =>
      generarXmlComunicacionBaja({
        empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-22',
        lineas: [{ tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1, motivo: 'x' }],
      }),
    ).toThrow(/resumen diario/);
  });

  it('exige motivo', () => {
    expect(() =>
      generarXmlComunicacionBaja({
        empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-22',
        lineas: [{ tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 1, motivo: ' ' }],
      }),
    ).toThrow(/motivo/);
  });

  it('identificador con correlativo válido', () => {
    expect(idResumen('RA', '2026-10-22', 1)).toBe('RA-20261022-1');
    expect(() => idResumen('RA', '2026-10-22', 0)).toThrow();
  });
});
