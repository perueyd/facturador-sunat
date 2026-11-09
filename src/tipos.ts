/**
 * Tipos del dominio: empresa, cliente, ítems y comprobantes.
 * Los códigos vienen de los catálogos de SUNAT (Anexo 8). ⚠️ Confirmar contra
 * la versión vigente de los catálogos antes de pasar a producción.
 */
import type { Decimal } from './dinero.js';
import type { TipoDocIdentidad } from './validaciones/documentos.js';

/** Catálogo 01: tipo de comprobante. */
export const TipoComprobante = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
  NOTA_DEBITO: '08',
} as const;
export type TipoComprobante = (typeof TipoComprobante)[keyof typeof TipoComprobante];

/** Catálogo 07: tipo de afectación del IGV (solo las que usamos por ahora). */
export const Afectacion = {
  GRAVADO: '10',
  EXONERADO: '20',
  INAFECTO: '30',
} as const;
export type Afectacion = (typeof Afectacion)[keyof typeof Afectacion];

export type Regimen = 'NUEVO_RUS' | 'RER' | 'MYPE_TRIBUTARIO' | 'GENERAL';

export interface Direccion {
  ubigeo: string; // 6 dígitos (catálogo 13)
  departamento: string;
  provincia: string;
  distrito: string;
  direccion: string;
  urbanizacion?: string;
  /** Código de establecimiento anexo registrado en SUNAT ("0000" = domicilio fiscal). */
  codigoLocal: string;
}

export interface Empresa {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  direccion: Direccion;
  regimen: Regimen;
}

export interface Cliente {
  tipoDoc: TipoDocIdentidad;
  numeroDoc: string;
  nombre: string;
  direccion?: string;
}

/** Ítem tal como llega del canal: precio con IGV incluido, como texto. */
export interface ItemEntrada {
  codigo?: string;
  descripcion: string;
  /** Catálogo 03 (UN/ECE rec 20): "NIU" = unidad (bienes), "ZZ" = servicio. */
  unidad: string;
  cantidad: string;
  precioUnitarioConIgv: string;
  afectacion: Afectacion;
}

export interface ItemCalculado {
  codigo?: string;
  descripcion: string;
  unidad: string;
  cantidad: Decimal;
  afectacion: Afectacion;
  /** Precio unitario con impuestos (PriceTypeCode 01). */
  precioUnitario: Decimal;
  /** Valor unitario sin IGV, hasta 10 decimales. */
  valorUnitario: Decimal;
  /** Valor de venta del ítem (base imponible), 2 decimales. */
  valorVenta: Decimal;
  igv: Decimal;
  /** Tasa en porcentaje para el XML (ej. 18). 0 si no es gravado. */
  porcentajeIgv: Decimal;
  /** Total del ítem con IGV: lo que paga el cliente. */
  total: Decimal;
}

export interface Totales {
  gravado: Decimal;
  exonerado: Decimal;
  inafecto: Decimal;
  igv: Decimal;
  /** Suma de valores de venta (LineExtensionAmount). */
  valorVenta: Decimal;
  /** Total con impuestos (TaxInclusiveAmount). */
  precioVenta: Decimal;
  /** Importe total a pagar (PayableAmount). */
  importeTotal: Decimal;
  /**
   * Descuento global que rebaja la base gravada (catálogo 53, código 02), sin IGV.
   * `base` es el valor de venta gravado ANTES del descuento. Con descuento, `gravado`
   * ya viene neto y el IGV se calcula sobre ese neto.
   */
  descuentoGlobal?: { monto: Decimal; base: Decimal };
}

export interface Cuota {
  monto: string;
  /** AAAA-MM-DD */
  fechaVencimiento: string;
}

export type FormaPago = { tipo: 'CONTADO' } | { tipo: 'CREDITO'; cuotas: Cuota[] };

/** Parámetros tributarios vigentes en la fecha de emisión (vienen de la base de datos). */
export interface ParametrosTributarios {
  /** Ej. "0.18" */
  igvTasa: Decimal;
  /** Monto a partir del cual la boleta exige identificar al cliente (ej. 700). */
  montoBoletaIdentificar: Decimal;
}

export interface DocumentoReferencia {
  tipo: TipoComprobante;
  serie: string;
  numero: number;
}

/** Comprobante que modifica una nota, el motivo (catálogo 09 crédito / 10 débito) y su texto. */
export interface DatosNota {
  referencia: DocumentoReferencia;
  motivoCodigo: string;
  motivoDescripcion: string;
}

/** Datos completos de un comprobante (factura, boleta, nota de crédito o de débito) ya numerado. */
export interface Comprobante {
  tipo: TipoComprobante;
  serie: string;
  numero: number;
  /** AAAA-MM-DD, hora de Lima */
  fechaEmision: string;
  /** HH:MM:SS, hora de Lima */
  horaEmision: string;
  moneda: 'PEN';
  empresa: Empresa;
  cliente: Cliente;
  items: ItemCalculado[];
  totales: Totales;
  formaPago: FormaPago;
  /** Solo notas de crédito (motivo del catálogo 09). */
  notaCredito?: DatosNota;
  /** Solo notas de débito (motivo del catálogo 10): cobrar algo más sobre una factura o boleta. */
  notaDebito?: DatosNota;
}

/** La nota (de crédito o de débito) del comprobante, si es una nota. */
export const notaDe = (c: { notaCredito?: DatosNota; notaDebito?: DatosNota }): DatosNota | undefined => c.notaCredito ?? c.notaDebito;

/** Formatea el número como lo pide SUNAT en el XML: "B001-1" (sin ceros a la izquierda). */
export function idComprobante(serie: string, numero: number): string {
  return `${serie}-${numero}`;
}

/** Formato para mostrar a personas: "B001-00000001". */
export function idComprobanteLegible(serie: string, numero: number): string {
  return `${serie}-${String(numero).padStart(8, '0')}`;
}
