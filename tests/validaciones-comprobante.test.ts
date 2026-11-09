import { describe, expect, it } from 'vitest';
import { prepararComprobante } from '../src/comprobantes/preparar.js';
import { Decimal } from '../src/dinero.js';
import { Afectacion, TipoComprobante } from '../src/tipos.js';
import { TipoDocIdentidad } from '../src/validaciones/documentos.js';
import { RUC_CLIENTE, contextoPrueba, item, solicitudBoleta, solicitudFactura } from './ayudantes.js';

function errores(...args: Parameters<typeof prepararComprobante>): string[] {
  const r = prepararComprobante(...args);
  return r.ok ? [] : r.errores;
}

describe('boletas', () => {
  it('una boleta correcta pasa', () => {
    expect(errores(solicitudBoleta(), contextoPrueba)).toEqual([]);
  });

  it('hasta S/ 700 se puede emitir sin documento del cliente', () => {
    const s = solicitudBoleta({
      items: [item('700.00')],
      cliente: { tipoDoc: TipoDocIdentidad.SIN_DOCUMENTO, numeroDoc: '-', nombre: 'CLIENTES VARIOS' },
    });
    expect(errores(s, contextoPrueba)).toEqual([]);
  });

  it('más de S/ 700 exige documento del cliente', () => {
    const s = solicitudBoleta({
      items: [item('700.01')],
      cliente: { tipoDoc: TipoDocIdentidad.SIN_DOCUMENTO, numeroDoc: '-', nombre: 'CLIENTES VARIOS' },
    });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/supera S\/ 700.00.*obligatorio el DNI/);
  });

  it('el límite de S/ 700 sale de los parámetros, no del código', () => {
    const ctx = { ...contextoPrueba, parametros: { ...contextoPrueba.parametros, montoBoletaIdentificar: new Decimal('500') } };
    const s = solicitudBoleta({
      items: [item('600.00')],
      cliente: { tipoDoc: TipoDocIdentidad.SIN_DOCUMENTO, numeroDoc: '-', nombre: 'CLIENTES VARIOS' },
    });
    expect(errores(s, ctx).length).toBe(1);
  });

  it('DNI mal escrito', () => {
    const s = solicitudBoleta({ cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '1234567', nombre: 'ANA' } });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/DNI "1234567" no es válido/);
  });

  it('la serie de boleta debe empezar con B', () => {
    expect(errores(solicitudBoleta({ serie: 'F001' }), contextoPrueba).join(' ')).toMatch(/debe empezar con B/);
  });
});

describe('facturas', () => {
  it('una factura correcta pasa', () => {
    expect(errores(solicitudFactura(), contextoPrueba)).toEqual([]);
  });

  it('exige RUC del cliente', () => {
    const s = solicitudFactura({ cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '12345678', nombre: 'JUAN' } });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/debe tener RUC/);
  });

  it('exige RUC con dígito verificador correcto', () => {
    const s = solicitudFactura({ cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: '20600000014', nombre: 'X S.A.C.' } });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/RUC "20600000014" no es válido/);
  });

  it('exige razón social', () => {
    const s = solicitudFactura({ cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: RUC_CLIENTE, nombre: '  ' } });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/razón social/);
  });

  it('Nuevo RUS no puede emitir facturas', () => {
    const ctx = {
      ...contextoPrueba,
      empresa: { ...contextoPrueba.empresa, regimen: 'NUEVO_RUS' as const },
      comprobantesPermitidos: [TipoComprobante.BOLETA, TipoComprobante.NOTA_CREDITO],
    };
    expect(errores(solicitudFactura(), ctx).join(' ')).toMatch(/Nuevo RUS no se pueden emitir facturas/);
  });

  it('crédito: las cuotas deben sumar el total y vencer después de la emisión', () => {
    const bien = solicitudFactura({
      items: [item('1000.00')],
      formaPago: { tipo: 'CREDITO', cuotas: [{ monto: '500.00', fechaVencimiento: '2026-11-20' }, { monto: '500.00', fechaVencimiento: '2026-12-20' }] },
    });
    expect(errores(bien, contextoPrueba)).toEqual([]);

    const mal = solicitudFactura({
      items: [item('1000.00')],
      formaPago: { tipo: 'CREDITO', cuotas: [{ monto: '400.00', fechaVencimiento: '2026-10-01' }] },
    });
    const e = errores(mal, contextoPrueba).join(' ');
    expect(e).toMatch(/suma de las cuotas/);
    expect(e).toMatch(/debe vencer después/);
  });
});

describe('ítems', () => {
  it('rechaza montos con coma o vacíos, con mensaje claro', () => {
    const s = solicitudBoleta({ items: [item('10,50')] });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/Ítem 1: el precio no es un número válido/);
  });

  it('exonerado solo si la empresa tiene exoneración vigente', () => {
    const s = solicitudBoleta({ items: [item('15.00', '1', { afectacion: Afectacion.EXONERADO })] });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/exoneración de IGV vigente/);
    const ctxTaxi = { ...contextoPrueba, afectacionesPermitidas: [Afectacion.GRAVADO, Afectacion.EXONERADO] };
    expect(errores(s, ctxTaxi)).toEqual([]);
  });

  it('rechaza caracteres invisibles que romperían el XML', () => {
    const s = solicitudBoleta({ items: [item('10.00', '1', { descripcion: 'Tarima\u0001' })] });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/caracteres invisibles/);
    const c = solicitudBoleta({ cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '12345678', nombre: 'ANA\u001B' } });
    expect(errores(c, contextoPrueba).join(' ')).toMatch(/caracteres invisibles/);
  });

  it('rechaza más de 10 decimales (la base de datos los redondearía sin avisar)', () => {
    const s = solicitudBoleta({ items: [item('10.00', '1.12345678901')] });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/más de 10 decimales/);
  });

  it('sin ítems no se emite', () => {
    expect(errores(solicitudBoleta({ items: [] }), contextoPrueba).join(' ')).toMatch(/al menos un producto/);
  });
});

describe('notas de crédito', () => {
  const base = {
    tipo: TipoComprobante.NOTA_CREDITO,
    serie: 'BC01',
    notaCredito: {
      referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 },
      motivoCodigo: '07',
      motivoDescripcion: 'Devolución de un producto',
    },
  } as const;

  it('una nota de crédito correcta pasa', () => {
    expect(errores(solicitudBoleta(base), contextoPrueba)).toEqual([]);
  });
  it('motivo fuera del catálogo 09', () => {
    const s = solicitudBoleta({ ...base, notaCredito: { ...base.notaCredito, motivoCodigo: '99' } });
    expect(errores(s, contextoPrueba).join(' ')).toMatch(/catálogo 09/);
  });
  it('la serie sigue a la del comprobante original (B para boletas)', () => {
    expect(errores(solicitudBoleta({ ...base, serie: 'FC01' }), contextoPrueba).join(' ')).toMatch(/debe empezar con B/);
  });
});

// Catálogo 10 (Anexo 8, R.S. 245-2017/SUNAT): 01 intereses por mora, 02 aumento en el valor,
// 03 penalidades / otros conceptos.
describe('notas de débito', () => {
  const base = {
    tipo: TipoComprobante.NOTA_DEBITO,
    serie: 'FD01',
    notaDebito: { referencia: { tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 1 }, motivoCodigo: '02', motivoDescripcion: 'Flete adicional' },
  } as const;

  it('una nota de débito correcta pasa', () => {
    expect(errores(solicitudFactura(base), contextoPrueba)).toEqual([]);
  });
  it('solo motivos del catálogo 10 (el 07 de crédito no vale)', () => {
    for (const motivo of ['01', '02', '03']) expect(errores(solicitudFactura({ ...base, notaDebito: { ...base.notaDebito, motivoCodigo: motivo } }), contextoPrueba)).toEqual([]);
    expect(errores(solicitudFactura({ ...base, notaDebito: { ...base.notaDebito, motivoCodigo: '07' } }), contextoPrueba).join(' ')).toMatch(/catálogo 10/);
  });
  it('lleva motivo escrito, serie F de la factura y referencia a una factura o boleta', () => {
    expect(errores(solicitudFactura({ ...base, notaDebito: { ...base.notaDebito, motivoDescripcion: ' ' } }), contextoPrueba).join(' ')).toMatch(/Escribe el motivo de la nota de débito/);
    expect(errores(solicitudFactura({ ...base, serie: 'BD01' }), contextoPrueba).join(' ')).toMatch(/debe empezar con F/);
    const deNota = { ...base.notaDebito, referencia: { tipo: TipoComprobante.NOTA_CREDITO, serie: 'FC01', numero: 1 } };
    expect(errores(solicitudFactura({ ...base, notaDebito: deNota }), contextoPrueba).join(' ')).toMatch(/solo puede modificar una factura o una boleta/);
  });
  it('sin la nota, o con la de crédito en vez de la de débito, no pasa', () => {
    expect(errores(solicitudFactura({ tipo: TipoComprobante.NOTA_DEBITO, serie: 'FD01' }), contextoPrueba).join(' ')).toMatch(/debe indicar el comprobante/);
    expect(errores(solicitudFactura({ tipo: TipoComprobante.NOTA_DEBITO, serie: 'FD01', notaCredito: base.notaDebito }), contextoPrueba).join(' ')).toMatch(/debe indicar el comprobante/);
    expect(errores(solicitudFactura({ notaDebito: base.notaDebito }), contextoPrueba).join(' ')).toMatch(/Solo las notas/);
  });
});
