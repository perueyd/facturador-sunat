/**
 * Datos de prueba compartidos. RUCs ficticios con dígito verificador válido.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ahoraLima } from '../src/fechas.js';
import { Decimal } from '../src/dinero.js';
import type { ContextoEmpresa, SolicitudComprobante } from '../src/comprobantes/preparar.js';
import { Afectacion, TipoComprobante, type Empresa, type ItemEntrada } from '../src/tipos.js';
import { TipoDocIdentidad } from '../src/validaciones/documentos.js';

export const RUC_EMPRESA = '20600000005';
export const RUC_CLIENTE = '20600000013';
export const RUC_PERSONA = '10456789124';

export const empresaPrueba: Empresa = {
  ruc: RUC_EMPRESA,
  razonSocial: 'EMPRESA DE PRUEBA S.A.C.',
  nombreComercial: 'Espacios y Diseño',
  regimen: 'MYPE_TRIBUTARIO',
  direccion: {
    ubigeo: '150101',
    departamento: 'LIMA',
    provincia: 'LIMA',
    distrito: 'LIMA',
    direccion: 'AV. PRUEBA 123',
    codigoLocal: '0000',
  },
};

export const contextoPrueba: ContextoEmpresa = {
  empresa: empresaPrueba,
  parametros: { igvTasa: new Decimal('0.18'), montoBoletaIdentificar: new Decimal('700') },
  comprobantesPermitidos: [TipoComprobante.FACTURA, TipoComprobante.BOLETA, TipoComprobante.NOTA_CREDITO],
  afectacionesPermitidas: [Afectacion.GRAVADO],
};

export function item(precio: string, cantidad = '1', extra: Partial<ItemEntrada> = {}): ItemEntrada {
  return {
    codigo: 'TAR-001',
    descripcion: 'Tarima de melamina 2 plazas',
    unidad: 'NIU',
    cantidad,
    precioUnitarioConIgv: precio,
    afectacion: Afectacion.GRAVADO,
    ...extra,
  };
}

/** Fecha fija para las pruebas que comparan el XML o el PDF texto por texto. */
export const FECHA_FIJA = '2026-10-20';

// Por defecto, hoy en Lima: el facturador no deja emitir con una fecha más antigua que el plazo
// de envío a SUNAT (parámetros PLAZO_ENVIO_*), así que una fecha fija dejaría de servir con el tiempo.
export function solicitudBoleta(extra: Partial<SolicitudComprobante> = {}): SolicitudComprobante {
  return {
    tipo: TipoComprobante.BOLETA,
    serie: 'B001',
    fechaEmision: ahoraLima().fecha,
    horaEmision: '10:30:00',
    cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '12345678', nombre: 'JUAN PÉREZ' },
    items: [item('350.00')],
    formaPago: { tipo: 'CONTADO' },
    ...extra,
  };
}

export function solicitudFactura(extra: Partial<SolicitudComprobante> = {}): SolicitudComprobante {
  return {
    tipo: TipoComprobante.FACTURA,
    serie: 'F001',
    fechaEmision: ahoraLima().fecha,
    horaEmision: '11:00:00',
    cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: RUC_CLIENTE, nombre: 'CLIENTE EMPRESA S.A.C.', direccion: 'JR. CLIENTE 456' },
    items: [item('1180.00'), item('59.90', '2', { codigo: 'ACC-010', descripcion: 'Almohada & funda "premium"' })],
    formaPago: { tipo: 'CONTADO' },
    ...extra,
  };
}

const XSD = fileURLToPath(new URL('./xsd/ubl-2.1/maindoc/', import.meta.url));

/**
 * Valida un XML contra el esquema oficial UBL 2.1 (OASIS) con xmllint.
 * El esquema exige contenido dentro de ExtensionContent (allí va la firma en la
 * fase 3), así que para validar se coloca un marcador de firma.
 */
export function validarContraXsd(xml: string, esquema: 'UBL-Invoice-2.1.xsd' | 'UBL-CreditNote-2.1.xsd'): string {
  const conMarcador = xml.replace(
    '<ext:ExtensionContent/>',
    '<ext:ExtensionContent><m:FirmaFase3 xmlns:m="urn:marcador-de-prueba"/></ext:ExtensionContent>',
  );
  try {
    return execFileSync('xmllint', ['--noout', '--schema', XSD + esquema, '-'], { input: conMarcador, stdio: 'pipe' }).toString();
  } catch (e) {
    const err = e as { stderr?: Buffer };
    throw new Error(`El XML no cumple el esquema UBL 2.1:\n${err.stderr?.toString() ?? String(e)}`);
  }
}

/** Las mismas solicitudes con FECHA_FIJA, para las pruebas sin base que comparan fechas exactas. */
export const boletaFija = (extra: Partial<SolicitudComprobante> = {}) => solicitudBoleta({ fechaEmision: FECHA_FIJA, ...extra });
export const facturaFija = (extra: Partial<SolicitudComprobante> = {}) => solicitudFactura({ fechaEmision: FECHA_FIJA, ...extra });
