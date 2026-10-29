/**
 * Validaciones de negocio ANTES de numerar y enviar un comprobante.
 * Devuelve una lista de errores en español claro; lista vacía = todo bien.
 */
import { dec, redondear, sumar } from '../dinero.js';
import {
  Afectacion,
  TipoComprobante,
  type Cliente,
  type FormaPago,
  type ItemEntrada,
  type ParametrosTributarios,
  type Regimen,
  type Totales,
  type DocumentoReferencia,
} from '../tipos.js';
import { TipoDocIdentidad, esDniValido, esRucValido } from './documentos.js';
import { esMotivoNotaCreditoValido } from '../catalogos.js';
import { esFecha } from '../fechas.js';

export interface DatosAValidar {
  tipo: TipoComprobante;
  serie: string;
  fechaEmision: string;
  cliente: Cliente;
  items: ItemEntrada[];
  totales: Totales;
  formaPago: FormaPago;
  /** Descuento global con IGV, como texto (solo facturas y boletas). */
  descuentoGlobal?: string;
  regimen: Regimen;
  parametros: ParametrosTributarios;
  /** Tipos de comprobante que el régimen de la empresa permite emitir (de la BD). */
  comprobantesPermitidos: TipoComprobante[];
  /** Afectaciones que la empresa puede usar (ej. exonerado solo si tiene exoneración vigente). */
  afectacionesPermitidas: Afectacion[];
  notaCredito?: {
    referencia: DocumentoReferencia;
    motivoCodigo: string;
    motivoDescripcion: string;
  };
}

// Caracteres de control (salvo tabulación y saltos de línea) no son válidos en XML.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** SUNAT acepta hasta 10 decimales en cantidad y valores unitarios; la BD guarda 10. */
const MAX_DECIMALES = 10;

export function validarComprobante(d: DatosAValidar): string[] {
  const errores: string[] = [];

  // Régimen
  if (!d.comprobantesPermitidos.includes(d.tipo)) {
    errores.push(
      d.regimen === 'NUEVO_RUS' && d.tipo === TipoComprobante.FACTURA
        ? 'En el Nuevo RUS no se pueden emitir facturas. Emite una boleta.'
        : `El régimen ${d.regimen} de esta empresa no permite emitir este tipo de comprobante (${d.tipo}).`,
    );
  }

  // Serie
  errores.push(...validarSerie(d.tipo, d.serie, d.notaCredito?.referencia.tipo));

  // Fecha
  if (!esFecha(d.fechaEmision)) {
    errores.push('La fecha de emisión debe tener el formato AAAA-MM-DD.');
  }

  // Ítems
  if (d.items.length === 0) errores.push('El comprobante debe tener al menos un producto o servicio.');
  d.items.forEach((item, i) => {
    const n = i + 1;
    if (!item.descripcion.trim()) errores.push(`Ítem ${n}: falta la descripción.`);
    if (CONTROL.test(item.descripcion) || (item.codigo && CONTROL.test(item.codigo))) {
      errores.push(`Ítem ${n}: la descripción o el código tienen caracteres invisibles no permitidos.`);
    }
    if (!d.afectacionesPermitidas.includes(item.afectacion)) {
      errores.push(
        item.afectacion === Afectacion.EXONERADO
          ? `Ítem ${n}: la empresa no tiene una exoneración de IGV vigente configurada.`
          : `Ítem ${n}: tipo de afectación del IGV no permitido (${item.afectacion}).`,
      );
    }
    for (const [campo, nombre] of [
      ['cantidad', 'la cantidad'],
      ['precioUnitarioConIgv', 'el precio'],
    ] as const) {
      try {
        const valor = dec(item[campo]);
        if (valor.lte(0)) errores.push(`Ítem ${n}: ${nombre} debe ser mayor que cero.`);
        if (valor.decimalPlaces() > MAX_DECIMALES) {
          errores.push(`Ítem ${n}: ${nombre} tiene más de ${MAX_DECIMALES} decimales.`);
        }
      } catch {
        errores.push(`Ítem ${n}: ${nombre} no es un número válido ("${item[campo]}").`);
      }
    }
  });

  // Cliente
  errores.push(...validarCliente(d));

  // Forma de pago
  errores.push(...validarFormaPago(d));
  errores.push(...validarDescuento(d));

  // Nota de crédito
  if (d.tipo === TipoComprobante.NOTA_CREDITO) {
    if (!d.notaCredito) {
      errores.push('La nota de crédito debe indicar el comprobante que modifica y el motivo.');
    } else {
      if (!esMotivoNotaCreditoValido(d.notaCredito.motivoCodigo)) {
        errores.push(`Motivo de nota de crédito no válido: "${d.notaCredito.motivoCodigo}" (catálogo 09).`);
      }
      if (CONTROL.test(d.notaCredito.motivoDescripcion)) {
        errores.push('El motivo de la nota de crédito tiene caracteres invisibles no permitidos.');
      }
      if (!d.notaCredito.motivoDescripcion.trim()) {
        errores.push('Escribe el motivo de la nota de crédito (por ejemplo, "Devolución del producto").');
      }
      const ref = d.notaCredito.referencia;
      if (ref.tipo !== TipoComprobante.FACTURA && ref.tipo !== TipoComprobante.BOLETA) {
        errores.push('La nota de crédito solo puede modificar una factura o una boleta.');
      }
    }
  }

  return errores;
}

function validarSerie(tipo: TipoComprobante, serie: string, tipoReferencia?: TipoComprobante): string[] {
  if (!/^[FB][A-Z0-9]{3}$/.test(serie)) {
    return [`La serie "${serie}" no es válida: deben ser 4 caracteres que empiecen con F (facturas) o B (boletas).`];
  }
  const letraEsperada =
    tipo === TipoComprobante.FACTURA ? 'F'
    : tipo === TipoComprobante.BOLETA ? 'B'
    : tipoReferencia === TipoComprobante.FACTURA ? 'F'
    : tipoReferencia === TipoComprobante.BOLETA ? 'B'
    : undefined;
  if (letraEsperada && !serie.startsWith(letraEsperada)) {
    return [`La serie "${serie}" debe empezar con ${letraEsperada} para este comprobante.`];
  }
  return [];
}

function validarCliente(d: DatosAValidar): string[] {
  const errores: string[] = [];
  const c = d.cliente;
  if ([c.nombre, c.numeroDoc, c.direccion ?? ''].some((t) => CONTROL.test(t))) {
    errores.push('Los datos del cliente tienen caracteres invisibles no permitidos.');
  }
  // Para notas de crédito, las reglas del cliente son las del comprobante que modifican.
  const tipoBase = d.tipo === TipoComprobante.NOTA_CREDITO ? d.notaCredito?.referencia.tipo : d.tipo;

  if (c.tipoDoc === TipoDocIdentidad.DNI && !esDniValido(c.numeroDoc)) {
    errores.push(`El DNI "${c.numeroDoc}" no es válido: debe tener exactamente 8 dígitos.`);
  }
  if (c.tipoDoc === TipoDocIdentidad.RUC && !esRucValido(c.numeroDoc)) {
    errores.push(`El RUC "${c.numeroDoc}" no es válido: revisa que tenga 11 dígitos y esté bien escrito.`);
  }

  if (tipoBase === TipoComprobante.FACTURA) {
    if (c.tipoDoc !== TipoDocIdentidad.RUC) {
      errores.push('Para emitir una factura el cliente debe tener RUC. Si no tiene, emite una boleta.');
    }
    if (!c.nombre.trim()) errores.push('Para emitir una factura falta la razón social del cliente.');
  }

  if (tipoBase === TipoComprobante.BOLETA) {
    const sinDocumento = c.tipoDoc === TipoDocIdentidad.SIN_DOCUMENTO || !c.numeroDoc.trim();
    if (d.totales.importeTotal.gt(d.parametros.montoBoletaIdentificar) && sinDocumento) {
      errores.push(
        `La boleta supera S/ ${d.parametros.montoBoletaIdentificar.toFixed(2)}: es obligatorio el DNI (u otro documento) y el nombre del cliente.`,
      );
    }
    if (!sinDocumento && !c.nombre.trim()) errores.push('Falta el nombre del cliente.');
  }
  return errores;
}

function validarDescuento(d: DatosAValidar): string[] {
  if (d.descuentoGlobal === undefined) return [];
  if (d.tipo !== TipoComprobante.FACTURA && d.tipo !== TipoComprobante.BOLETA) {
    return ['El descuento global solo se usa en facturas y boletas. En una nota de crédito pon los montos ya rebajados.'];
  }
  if (!/^\d+(\.\d{1,2})?$/.test(d.descuentoGlobal) || dec(d.descuentoGlobal).lte(0)) {
    return ['El descuento debe ser un monto mayor que cero con hasta 2 decimales, por ejemplo "50.00".'];
  }
  let totalGravado;
  try {
    totalGravado = sumar(d.items.filter((i) => i.afectacion === Afectacion.GRAVADO).map((i) => redondear(dec(i.cantidad).times(dec(i.precioUnitarioConIgv)))));
  } catch {
    return []; // los montos inválidos de los ítems ya se reportan aparte
  }
  if (totalGravado.isZero()) return ['El descuento global solo puede aplicarse a productos gravados con IGV.'];
  if (!dec(d.descuentoGlobal).lt(totalGravado)) {
    return [`El descuento (S/ ${dec(d.descuentoGlobal).toFixed(2)}) debe ser menor que el total de los productos gravados (S/ ${totalGravado.toFixed(2)}).`];
  }
  return [];
}

function validarFormaPago(d: DatosAValidar): string[] {
  if (d.formaPago.tipo === 'CONTADO') return [];
  const errores: string[] = [];
  if (d.tipo !== TipoComprobante.FACTURA) {
    // ⚠️ SUNAT exige forma de pago en facturas; para otros tipos no lo usamos por ahora.
    errores.push('La venta al crédito con cuotas solo está habilitada para facturas.');
  }
  const cuotas = d.formaPago.cuotas;
  if (cuotas.length === 0) errores.push('Una venta al crédito necesita al menos una cuota.');
  let montos;
  try {
    montos = cuotas.map((q) => dec(q.monto));
  } catch {
    return [...errores, 'Hay una cuota con un monto que no es un número válido.'];
  }
  if (montos.some((m) => m.lte(0))) errores.push('Cada cuota debe tener un monto mayor que cero.');
  // ⚠️ El monto pendiente debe considerar detracciones/retenciones si existieran (no aplican por ahora).
  if (!sumar(montos).eq(d.totales.importeTotal)) {
    errores.push(
      `La suma de las cuotas (S/ ${sumar(montos).toFixed(2)}) debe ser igual al total (S/ ${d.totales.importeTotal.toFixed(2)}).`,
    );
  }
  cuotas.forEach((q, i) => {
    if (!esFecha(q.fechaVencimiento) || q.fechaVencimiento <= d.fechaEmision) {
      errores.push(`La cuota ${i + 1} debe vencer después de la fecha de emisión.`);
    }
  });
  return errores;
}
