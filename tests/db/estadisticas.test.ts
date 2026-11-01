/**
 * Estadísticas del panel: lo que el dueño mira primero. Se prueba que los montos salgan de
 * los comprobantes válidos (sin rechazados), que la comparación con el mes anterior sea por
 * los MISMOS días y que el alto de las barras lo calcule el facturador.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import { enTransaccion, type Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { estadisticas } from '../../src/reportes/estadisticas.js';
import type { SolicitudComprobante } from '../../src/comprobantes/preparar.js';
import { TipoComprobante } from '../../src/tipos.js';
import { TipoDocIdentidad } from '../../src/validaciones/documentos.js';
import { item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('estadísticas de ventas', () => {
  let db: Db;
  let f: Fixture;
  const hoy = ahoraLima().fecha;
  // El mismo día del mes anterior (PostgreSQL ajusta el 31 al último día del mes).
  let haceUnMes: string;

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    haceUnMes = (await db.query(`SELECT ($1::date - interval '1 month')::date::text AS d`, [hoy])).rows[0].d;
  });

  async function venta(canalId: string, solicitud: SolicitudComprobante, fecha?: string) {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId, solicitud });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
    // Ventas de otros días: se emite hoy y se mueve la fecha. Un comprobante emitido no se
    // puede modificar (lo impide un trigger), así que solo en la base de pruebas y dentro de una
    // transacción se apaga ese trigger un instante.
    if (fecha) {
      await enTransaccion(db, async (tx) => {
        await tx.query(`ALTER TABLE comprobantes DISABLE TRIGGER comprobantes_contenido_fijo`);
        await tx.query(`UPDATE comprobantes SET fecha_emision = $2 WHERE id = $1`, [r.guardado.id, fecha]);
        await tx.query(`ALTER TABLE comprobantes ENABLE TRIGGER comprobantes_contenido_fijo`);
      });
    }
    return r.guardado.id;
  }

  it('hoy, mes, ticket promedio, clientes nuevos, 6 meses, 30 días, canales y productos', async () => {
    const vacia = await estadisticas(db, f.empresaId, { hoy });
    expect(vacia.mes).toEqual({ ventas: '0.00', comprobantes: 0, ticketPromedio: '0.00', variacion: null });
    expect(vacia.meses.every((m) => m.alto === 0)).toBe(true);

    // Mes anterior (mismos días): 100.00 del cliente 12345678.
    await venta(f.canalManual, solicitudBoleta({ fechaEmision: hoy, items: [item('100.00')] }), haceUnMes);
    // Hoy: 2 × 118.00 por WhatsApp (cliente que ya compró) y 59.00 por la tienda (cliente nuevo).
    await venta(f.canalManual, solicitudBoleta({ fechaEmision: hoy, items: [item('118.00', '2')] }));
    await venta(f.canalTienda, solicitudBoleta({
      fechaEmision: hoy, cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '87654321', nombre: 'ANA RUIZ' },
      items: [item('59.00', '1', { codigo: 'ALM-01', descripcion: 'Almohada' })],
    }));
    // Un rechazado no es venta.
    const rechazado = await venta(f.canalManual, solicitudBoleta({ fechaEmision: hoy, items: [item('999.00')] }));
    await db.query(`UPDATE comprobantes SET estado = 'RECHAZADO' WHERE id = $1`, [rechazado]);

    const e = await estadisticas(db, f.empresaId, { hoy, compras: true, productos: true });
    expect(e.hoy).toEqual({ ventas: '295.00', comprobantes: 2, notasCredito: '0.00' });
    // (295 - 100) / 100 = +195 %
    expect(e.mes).toEqual({ ventas: '295.00', comprobantes: 2, ticketPromedio: '147.50', variacion: '195.0' });
    expect(e.clientes).toEqual({ mes: 2, nuevos: 1 });

    expect(e.meses).toHaveLength(6);
    expect(e.meses.at(-1)).toMatchObject({ periodo: hoy.slice(0, 7), ventas: '295.00', alto: 100, compras: '0.00', altoCompras: 0 });
    expect(e.meses.at(-2)).toMatchObject({ periodo: haceUnMes.slice(0, 7), ventas: '100.00', alto: 34 });

    expect(e.dias).toHaveLength(30);
    expect(e.dias.at(-1)).toEqual({ fecha: hoy, ventas: '295.00', alto: 100 });

    expect(e.canales).toEqual([
      { canal: 'WhatsApp', ventas: '236.00', porcentaje: 80 },
      { canal: 'Tienda web', ventas: '59.00', porcentaje: 20 },
    ]);
    expect(e.productos).toEqual([
      { descripcion: 'Tarima de melamina 2 plazas', cantidad: '2', ventas: '236.00', alto: 100 },
      { descripcion: 'Almohada', cantidad: '1', ventas: '59.00', alto: 25 },
    ]);
    expect(e.stockBajo).toBe(0);

    // Sin las funciones de compras y productos, esos datos no se calculan.
    const sin = await estadisticas(db, f.empresaId, { hoy });
    expect(sin.meses[0]!.compras).toBeUndefined();
    expect(sin.stockBajo).toBeUndefined();
  });

  it('una nota de crédito de hoy no deja "ventas de hoy" en negativo: se muestra aparte', async () => {
    // Corrige una venta del mes pasado (B001-00000001): hoy no se vendió menos, se devolvió.
    await venta(f.canalManual, {
      ...solicitudBoleta({ fechaEmision: hoy, items: [item('100.00')] }),
      tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01',
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo: '07', motivoDescripcion: 'Devolución' },
    });
    const e = await estadisticas(db, f.empresaId, { hoy });
    expect(e.hoy).toEqual({ ventas: '295.00', comprobantes: 2, notasCredito: '100.00' });
    // El mes sí es neto: lo vendido menos lo devuelto.
    expect(e.mes.ventas).toBe('195.00');
  });

  it('ventas por vendedor: la devolución resta a quien vendió, no a quien la hizo', async () => {
    const usuario = async (n: string) =>
      (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ($1, $2) RETURNING id`, [`${n.toLowerCase()}@vendedores.pe`, n])).rows[0].id as string;
    const ana = await usuario('Ana');
    const beto = await usuario('Beto');
    const emitirComo = async (usuarioId: string, s: SolicitudComprobante) => {
      const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: s, usuarioId });
      if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
      return r.guardado.id;
    };
    const deAna = await emitirComo(ana, solicitudBoleta({ fechaEmision: hoy, items: [item('50.00')] }));
    await emitirComo(beto, solicitudBoleta({ fechaEmision: hoy, items: [item('30.00')] }));
    const { numero } = (await db.query(`SELECT numero FROM comprobantes WHERE id = $1`, [deAna])).rows[0];
    // Beto atiende la devolución de una venta de Ana: le resta a Ana.
    await emitirComo(beto, {
      ...solicitudBoleta({ fechaEmision: hoy, items: [item('10.00')] }),
      tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01',
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: Number(numero) }, motivoCodigo: '07', motivoDescripcion: 'Devolución' },
    });
    // Ana gana 10 % sobre sus ventas sin IGV: (42.37 − 8.47) × 10 % = 3.39. Beto no tiene comisión.
    await db.query(`INSERT INTO usuario_empresa (usuario_id, empresa_id, rol, comision) VALUES ($1, $2, 'VENDEDOR', 10), ($3, $2, 'VENDEDOR', NULL)`, [ana, f.empresaId, beto]);
    const { vendedores } = await estadisticas(db, f.empresaId, { hoy });
    expect(vendedores).toEqual([
      { vendedor: 'Tienda / API', comprobantes: 2, ventas: '195.00', alto: 100 },
      { vendedor: 'Ana', comprobantes: 1, ventas: '40.00', alto: 21, comision: { porcentaje: '10', monto: '3.39' } },
      { vendedor: 'Beto', comprobantes: 1, ventas: '30.00', alto: 15 },
    ]);
  });
});
