/**
 * Catálogos de SUNAT usados por el generador de XML.
 * Fuente: Anexo 8 de la R.S. 097-2012/SUNAT y modificatorias.
 * ⚠️ Transcritos de referencias secundarias (oct-2026): confirmar contra la
 * versión oficial vigente antes de pasar a producción.
 */
import { Afectacion } from './tipos.js';

/** Catálogo 05: tributo según la afectación del IGV (id, nombre, código internacional). */
export const TRIBUTO_POR_AFECTACION: Record<Afectacion, { id: string; nombre: string; codigo: string }> = {
  [Afectacion.GRAVADO]: { id: '1000', nombre: 'IGV', codigo: 'VAT' },
  [Afectacion.EXONERADO]: { id: '9997', nombre: 'EXO', codigo: 'VAT' },
  [Afectacion.INAFECTO]: { id: '9998', nombre: 'INA', codigo: 'FRE' },
};

/** Catálogo 09: motivos de la nota de crédito. */
export const MOTIVOS_NOTA_CREDITO: Record<string, string> = {
  '01': 'Anulación de la operación',
  '02': 'Anulación por error en el RUC',
  '03': 'Corrección por error en la descripción',
  '04': 'Descuento global',
  '05': 'Descuento por ítem',
  '06': 'Devolución total',
  '07': 'Devolución por ítem',
  '08': 'Bonificación',
  '09': 'Disminución en el valor',
  '10': 'Otros conceptos',
  '13': 'Ajustes – montos y/o fechas de pago',
};

export function esMotivoNotaCreditoValido(codigo: string): boolean {
  return Object.hasOwn(MOTIVOS_NOTA_CREDITO, codigo);
}

/**
 * Catálogo 10: tipo de nota de débito según motivo (cbc:ResponseCode).
 * Fuente oficial: Anexo 8 de la R.S. 245-2017/SUNAT, leído el 09/11/2026 en
 * www.sunat.gob.pe/legislacion/superin/2017/anexoE-245-2017.pdf (los anexos de la R.S. 114-2019
 * no lo cambian). Los códigos de exportación/IVAP que no usamos no se incluyen.
 */
export const MOTIVOS_NOTA_DEBITO: Record<string, string> = {
  '01': 'Intereses por mora',
  '02': 'Aumento en el valor',
  '03': 'Penalidades / otros conceptos',
};

export function esMotivoNotaDebitoValido(codigo: string): boolean {
  return Object.hasOwn(MOTIVOS_NOTA_DEBITO, codigo);
}

/** Catálogo 51: tipo de operación. 0101 = venta interna. */
export const TIPO_OPERACION_VENTA_INTERNA = '0101';

/** Catálogo 52: leyenda "monto en letras". */
export const LEYENDA_MONTO_EN_LETRAS = '1000';

/** Catálogo 19: estado del ítem en el resumen diario. */
export const CondicionResumen = {
  ADICIONAR: '1',
  MODIFICAR: '2',
  ANULAR: '3',
} as const;
export type CondicionResumen = (typeof CondicionResumen)[keyof typeof CondicionResumen];
