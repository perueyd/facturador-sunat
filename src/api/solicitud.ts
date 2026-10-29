/**
 * Convierte el JSON que envía un canal en una solicitud de comprobante.
 * Ver el formato completo en docs/API.md.
 *
 * Regla de dinero: los montos deben llegar como TEXTO ("59.90"), nunca como número
 * de JavaScript, para no arrastrar errores de punto flotante desde la tienda.
 */
import { dec } from '../dinero.js';
import { MEDIOS_PAGO, type MedioPago } from '../cobros/pagos.js';
import type { SolicitudComprobante } from '../comprobantes/preparar.js';
import { ahoraLima, esFecha } from '../fechas.js';
import { Afectacion, TipoComprobante, type Cuota, type FormaPago, type ItemEntrada } from '../tipos.js';
import { TipoDocIdentidad } from '../validaciones/documentos.js';

const TIPOS: Record<string, TipoComprobante> = {
  FACTURA: TipoComprobante.FACTURA,
  BOLETA: TipoComprobante.BOLETA,
  NOTA_CREDITO: TipoComprobante.NOTA_CREDITO,
};
const DOCUMENTOS: Record<string, TipoDocIdentidad> = {
  DNI: TipoDocIdentidad.DNI,
  RUC: TipoDocIdentidad.RUC,
  CE: TipoDocIdentidad.CARNET_EXTRANJERIA,
  PASAPORTE: TipoDocIdentidad.PASAPORTE,
  NINGUNO: TipoDocIdentidad.SIN_DOCUMENTO,
};
const AFECTACIONES: Record<string, Afectacion> = {
  GRAVADO: Afectacion.GRAVADO,
  EXONERADO: Afectacion.EXONERADO,
  INAFECTO: Afectacion.INAFECTO,
};
/** Serie por defecto según el tipo (y, en notas de crédito, según el documento que modifican). */
const SERIE_POR_DEFECTO = { '01': 'F001', '03': 'B001', '07-01': 'FC01', '07-03': 'BC01' } as const;

export interface PedidoApi {
  pedido: string;
  marca?: string;
  solicitud: SolicitudComprobante;
  /** Pago ya confirmado (ej. Yape): se registra por el total al emitir. */
  pago?: { medio: MedioPago; referencia?: string; cuentaId?: string };
}

type R<T> = { ok: true; valor: T } | { ok: false; errores: string[] };

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);

function monto(v: unknown, campo: string, errores: string[]): string {
  if (typeof v === 'number') {
    errores.push(`${campo}: envía el monto como texto, por ejemplo "59.90" (no como número).`);
    return '0';
  }
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v.trim())) {
    errores.push(`${campo}: monto inválido; usa texto con punto decimal, por ejemplo "59.90".`);
    return '0';
  }
  return v.trim();
}

function cantidad(v: unknown, campo: string, errores: string[]): string {
  // Las cantidades enteras pueden venir como número (2); las decimales, como texto ("1.5").
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  errores.push(`${campo}: cantidad inválida; usa un entero (2) o texto ("1.5").`);
  return '0';
}

export function leerPedido(cuerpo: unknown, hoy = ahoraLima()): R<PedidoApi> {
  const errores: string[] = [];
  if (!esObjeto(cuerpo)) return { ok: false, errores: ['El cuerpo debe ser un objeto JSON.'] };

  const pedido = texto(cuerpo.pedido);
  if (!pedido || pedido.length > 100) errores.push('pedido: obligatorio (el número de pedido de tu tienda, máximo 100 caracteres).');

  const tipo = TIPOS[texto(cuerpo.tipo)?.toUpperCase() ?? ''];
  if (!tipo) errores.push('tipo: debe ser "BOLETA", "FACTURA" o "NOTA_CREDITO".');

  // Cliente
  const c = esObjeto(cuerpo.cliente) ? cuerpo.cliente : {};
  const tipoDoc = DOCUMENTOS[texto(c.tipoDocumento)?.toUpperCase() ?? 'NINGUNO'];
  if (!tipoDoc) errores.push(`cliente.tipoDocumento: usa ${Object.keys(DOCUMENTOS).join(', ')}.`);
  const sinDocumento = tipoDoc === TipoDocIdentidad.SIN_DOCUMENTO;
  const cliente = {
    tipoDoc: tipoDoc ?? TipoDocIdentidad.SIN_DOCUMENTO,
    numeroDoc: sinDocumento ? '-' : (texto(c.numero) ?? ''),
    nombre: texto(c.nombre) || (sinDocumento ? 'CLIENTES VARIOS' : ''),
    ...(texto(c.direccion) ? { direccion: texto(c.direccion)! } : {}),
  };

  // Ítems
  const items: ItemEntrada[] = [];
  if (!Array.isArray(cuerpo.items) || cuerpo.items.length === 0) {
    errores.push('items: envía al menos un producto.');
  } else if (cuerpo.items.length > 200) {
    errores.push('items: máximo 200 productos por comprobante.');
  } else {
    cuerpo.items.forEach((x, i) => {
      const n = `items[${i}]`;
      if (!esObjeto(x)) return void errores.push(`${n}: debe ser un objeto.`);
      const afectacion = AFECTACIONES[texto(x.afectacion)?.toUpperCase() ?? 'GRAVADO'];
      if (!afectacion) errores.push(`${n}.afectacion: usa GRAVADO, EXONERADO o INAFECTO.`);
      items.push({
        ...(texto(x.codigo) ? { codigo: texto(x.codigo)! } : {}),
        descripcion: texto(x.descripcion) ?? '',
        unidad: texto(x.unidad)?.toUpperCase() || 'NIU',
        cantidad: cantidad(x.cantidad ?? 1, `${n}.cantidad`, errores),
        precioUnitarioConIgv: monto(x.precio, `${n}.precio`, errores),
        afectacion: afectacion ?? Afectacion.GRAVADO,
      });
    });
  }

  // Forma de pago
  let formaPago: FormaPago = { tipo: 'CONTADO' };
  if (esObjeto(cuerpo.formaPago)) {
    const cuotas = cuerpo.formaPago.cuotas;
    if (!Array.isArray(cuotas) || cuotas.length === 0) {
      errores.push('formaPago.cuotas: para venta al crédito envía al menos una cuota.');
    } else {
      formaPago = {
        tipo: 'CREDITO',
        cuotas: cuotas.map((q, i): Cuota => ({
          monto: esObjeto(q) ? monto(q.monto, `formaPago.cuotas[${i}].monto`, errores) : '0',
          fechaVencimiento: (esObjeto(q) && texto(q.vence)) || '',
        })),
      };
    }
  } else if (cuerpo.formaPago !== undefined && texto(cuerpo.formaPago)?.toUpperCase() !== 'CONTADO') {
    errores.push('formaPago: usa "CONTADO" o { "cuotas": [...] }.');
  }

  // Nota de crédito
  let notaCredito: SolicitudComprobante['notaCredito'];
  if (tipo === TipoComprobante.NOTA_CREDITO) {
    const nc = esObjeto(cuerpo.notaCredito) ? cuerpo.notaCredito : undefined;
    const refTipo = TIPOS[texto(nc?.tipo)?.toUpperCase() ?? ''];
    const numero = typeof nc?.numero === 'number' ? nc.numero : Number(texto(nc?.numero));
    if (!nc || !refTipo || refTipo === TipoComprobante.NOTA_CREDITO || !texto(nc.serie) || !Number.isSafeInteger(numero) || numero < 1) {
      errores.push('notaCredito: indica { "tipo": "FACTURA" | "BOLETA", "serie": "F001", "numero": 15, "motivo": "07", "descripcion": "..." }.');
    } else {
      notaCredito = {
        referencia: { tipo: refTipo, serie: texto(nc.serie)!.toUpperCase(), numero },
        motivoCodigo: texto(nc.motivo) ?? '',
        motivoDescripcion: texto(nc.descripcion) ?? '',
      };
    }
  }

  // Descuento global con IGV (cupón u oferta de la tienda): el total queda en (suma de ítems − descuento).
  const descuento = cuerpo.descuento === undefined ? undefined : monto(cuerpo.descuento, 'descuento', errores);

  let pago: PedidoApi['pago'];
  if (cuerpo.pago !== undefined) {
    const medio = texto(esObjeto(cuerpo.pago) ? cuerpo.pago.medio : undefined)?.toUpperCase() as MedioPago | undefined;
    if (!esObjeto(cuerpo.pago) || !medio || !MEDIOS_PAGO.includes(medio)) {
      errores.push(`pago: indica { "medio": ${MEDIOS_PAGO.map((m) => `"${m}"`).join(' | ')}, "referencia": "nº de operación" }.`);
    } else {
      const referencia = texto(cuerpo.pago.referencia);
      // Opcional: la cuenta donde entró el dinero (id). Sin ella, la predeterminada del medio.
      const cuenta = texto(cuerpo.pago.cuenta);
      if (cuenta && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cuenta)) errores.push('pago.cuenta: identificador de cuenta inválido.');
      pago = { medio, ...(referencia ? { referencia } : {}), ...(cuenta ? { cuentaId: cuenta } : {}) };
    }
  }

  const fecha = texto(cuerpo.fecha) ?? hoy.fecha;
  if (!esFecha(fecha)) errores.push('fecha: usa el formato AAAA-MM-DD.');

  const clave = tipo === TipoComprobante.NOTA_CREDITO ? `07-${notaCredito?.referencia.tipo ?? '01'}` : tipo;
  const serie = texto(cuerpo.serie)?.toUpperCase() || SERIE_POR_DEFECTO[clave as keyof typeof SERIE_POR_DEFECTO] || '';

  if (errores.length > 0 || !tipo || !pedido) return { ok: false, errores };
  return {
    ok: true,
    valor: {
      pedido,
      ...(texto(cuerpo.marca) ? { marca: texto(cuerpo.marca)! } : {}),
      ...(pago ? { pago } : {}),
      solicitud: {
        tipo,
        serie,
        fechaEmision: fecha,
        horaEmision: hoy.hora,
        cliente,
        items,
        formaPago,
        // "0.00" = sin descuento (la tienda puede mandarlo siempre).
        ...(descuento !== undefined && dec(descuento).gt(0) ? { descuentoGlobal: descuento } : {}),
        ...(notaCredito ? { notaCredito } : {}),
      },
    },
  };
}
