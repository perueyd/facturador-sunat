/**
 * Prepara un comprobante: calcula IGV y totales y aplica todas las validaciones.
 * No toca la base de datos ni asigna número: eso lo hace `emitir` dentro de una
 * transacción, solo si aquí no hubo errores.
 */
import { calcularItems, calcularTotales } from '../calculos/igv.js';
import { dec } from '../dinero.js';
import type {
  Afectacion,
  Cliente,
  Comprobante,
  DatosNota,
  Empresa,
  FormaPago,
  ItemEntrada,
  ParametrosTributarios,
  TipoComprobante,
} from '../tipos.js';
import { validarComprobante } from '../validaciones/comprobante.js';

export interface SolicitudComprobante {
  tipo: TipoComprobante;
  serie: string;
  fechaEmision: string;
  horaEmision: string;
  cliente: Cliente;
  items: ItemEntrada[];
  formaPago: FormaPago;
  /** Descuento global con IGV (cupón, oferta): se resta del total de los productos gravados. */
  descuentoGlobal?: string;
  notaCredito?: DatosNota;
  notaDebito?: DatosNota;
}

export interface ContextoEmpresa {
  empresa: Empresa;
  parametros: ParametrosTributarios;
  comprobantesPermitidos: TipoComprobante[];
  afectacionesPermitidas: Afectacion[];
}

/** Comprobante listo, al que solo le falta el número correlativo. */
export type ComprobanteSinNumero = Omit<Comprobante, 'numero'>;

export type ResultadoPreparacion =
  | { ok: true; comprobante: ComprobanteSinNumero }
  | { ok: false; errores: string[] };

export function prepararComprobante(s: SolicitudComprobante, ctx: ContextoEmpresa): ResultadoPreparacion {
  let items;
  try {
    items = calcularItems(s.items, ctx.parametros.igvTasa);
  } catch {
    // Montos mal escritos: dejamos que las validaciones den el detalle por ítem.
    items = undefined;
  }
  let totales = calcularTotales(items ?? []);
  if (items && s.descuentoGlobal !== undefined) {
    try {
      totales = calcularTotales(items, { conIgv: dec(s.descuentoGlobal), igvTasa: ctx.parametros.igvTasa });
    } catch {
      // Descuento inválido: las validaciones explican por qué.
    }
  }

  const errores = validarComprobante({
    tipo: s.tipo,
    serie: s.serie,
    fechaEmision: s.fechaEmision,
    cliente: s.cliente,
    items: s.items,
    totales,
    formaPago: s.formaPago,
    ...(s.descuentoGlobal !== undefined ? { descuentoGlobal: s.descuentoGlobal } : {}),
    regimen: ctx.empresa.regimen,
    parametros: ctx.parametros,
    comprobantesPermitidos: ctx.comprobantesPermitidos,
    afectacionesPermitidas: ctx.afectacionesPermitidas,
    ...(s.notaCredito ? { notaCredito: s.notaCredito } : {}),
    ...(s.notaDebito ? { notaDebito: s.notaDebito } : {}),
  });
  if (!/^\d{2}:\d{2}:\d{2}$/.test(s.horaEmision)) errores.push('La hora de emisión debe tener el formato HH:MM:SS.');
  if (errores.length > 0 || !items) {
    return { ok: false, errores: errores.length > 0 ? errores : ['Hay montos con formato inválido.'] };
  }

  return {
    ok: true,
    comprobante: {
      tipo: s.tipo,
      serie: s.serie,
      fechaEmision: s.fechaEmision,
      horaEmision: s.horaEmision,
      moneda: 'PEN',
      empresa: ctx.empresa,
      cliente: s.cliente,
      items,
      totales,
      formaPago: s.formaPago,
      ...(s.notaCredito ? { notaCredito: s.notaCredito } : {}),
      ...(s.notaDebito ? { notaDebito: s.notaDebito } : {}),
    },
  };
}
