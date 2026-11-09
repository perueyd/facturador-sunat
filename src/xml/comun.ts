/**
 * Piezas comunes de los XML UBL que pide SUNAT.
 * Referencia de estructura: guías de elaboración XML UBL 2.1 de SUNAT y las
 * plantillas de la librería abierta Greenter (thegreenter/xml), ampliamente
 * aceptadas por SUNAT. ⚠️ La validación definitiva se hace en SUNAT beta (fase 4).
 */
import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import { aTexto2 } from '../dinero.js';
import type { Decimal } from '../dinero.js';
import type { Empresa } from '../tipos.js';
import { TipoDocIdentidad } from '../validaciones/documentos.js';

export type Nodo = XMLBuilder;

export const NS = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  debitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  summary: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1',
  voided: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  sac: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1',
} as const;

/** Id del nodo de firma; el firmador (fase 3) debe usar este mismo valor. */
export const ID_FIRMA = 'SignatureSP';

export function crearDocumento(raiz: keyof typeof NS, nombreRaiz: string, conSac: boolean): Nodo {
  const atributos: Record<string, string> = {
    'xmlns:cac': NS.cac,
    'xmlns:cbc': NS.cbc,
    'xmlns:ds': NS.ds,
    'xmlns:ext': NS.ext,
  };
  if (conSac) atributos['xmlns:sac'] = NS.sac;
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS[raiz], nombreRaiz, atributos);
  // Lugar donde la fase 3 insertará la firma digital.
  doc.ele('ext:UBLExtensions').ele('ext:UBLExtension').ele('ext:ExtensionContent');
  return doc;
}

/** Agrega un elemento con texto (el texto se escapa automáticamente). */
export function el(padre: Nodo, nombre: string, texto: string, atributos?: Record<string, string>): Nodo {
  return padre.ele(nombre, atributos ?? {}).txt(texto);
}

export function monto(padre: Nodo, nombre: string, valor: Decimal, moneda: string): Nodo {
  return el(padre, nombre, aTexto2(valor), { currencyID: moneda });
}

export function firmaReferencia(padre: Nodo, empresa: Empresa): void {
  const s = padre.ele('cac:Signature');
  el(s, 'cbc:ID', `SIGN${empresa.ruc}`);
  const p = s.ele('cac:SignatoryParty');
  el(p.ele('cac:PartyIdentification'), 'cbc:ID', empresa.ruc);
  el(p.ele('cac:PartyName'), 'cbc:Name', empresa.razonSocial);
  el(s.ele('cac:DigitalSignatureAttachment').ele('cac:ExternalReference'), 'cbc:URI', `#${ID_FIRMA}`);
}

/** Emisor en formato UBL 2.1 (facturas, boletas, notas). */
export function emisor(padre: Nodo, e: Empresa): void {
  const party = padre.ele('cac:AccountingSupplierParty').ele('cac:Party');
  el(party.ele('cac:PartyIdentification'), 'cbc:ID', e.ruc, { schemeID: TipoDocIdentidad.RUC });
  if (e.nombreComercial) el(party.ele('cac:PartyName'), 'cbc:Name', e.nombreComercial);
  const legal = party.ele('cac:PartyLegalEntity');
  el(legal, 'cbc:RegistrationName', e.razonSocial);
  const dir = legal.ele('cac:RegistrationAddress');
  const d = e.direccion;
  el(dir, 'cbc:ID', d.ubigeo);
  el(dir, 'cbc:AddressTypeCode', d.codigoLocal);
  if (d.urbanizacion) el(dir, 'cbc:CitySubdivisionName', d.urbanizacion);
  el(dir, 'cbc:CityName', d.provincia);
  el(dir, 'cbc:CountrySubentity', d.departamento);
  el(dir, 'cbc:District', d.distrito);
  el(dir.ele('cac:AddressLine'), 'cbc:Line', d.direccion);
  el(dir.ele('cac:Country'), 'cbc:IdentificationCode', 'PE');
}

/** Emisor en formato de resúmenes y bajas (esquema SUNAT basado en UBL 2.0). */
export function emisorResumen(padre: Nodo, e: Empresa): void {
  const s = padre.ele('cac:AccountingSupplierParty');
  el(s, 'cbc:CustomerAssignedAccountID', e.ruc);
  el(s, 'cbc:AdditionalAccountID', TipoDocIdentidad.RUC);
  el(s.ele('cac:Party').ele('cac:PartyLegalEntity'), 'cbc:RegistrationName', e.razonSocial);
}

/**
 * Serializa el documento. Por defecto sin sangrías (como lo envían la mayoría de
 * emisores); `legible` solo para mostrar ejemplos a personas.
 */
export function terminar(doc: Nodo, legible = false): string {
  return doc.end({ prettyPrint: legible });
}
