/**
 * Reposición y Kardex: qué pedir, cuándo y cuánto. Se prueba con números a mano para que el
 * costo promedio, el punto de pedido y la cantidad sugerida no se desvíen sin que se note.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { registrarCompra } from '../../src/inventario/compras.js';
import { guardarProducto } from '../../src/inventario/productos.js';
import { asignarProveedor, guardarDiasEntrega, kardex, reposicion } from '../../src/inventario/reposicion.js';
import { RUC_CLIENTE, item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('reposición y Kardex', () => {
  let db: Db;
  let f: Fixture;
  const hoy = ahoraLima().fecha;
  let numero = 0;

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
  });

  const compra = (sku: string, cantidad: string, costo: string) => {
    const base = (Number(cantidad) * Number(costo)).toFixed(2);
    const igv = (Number(base) * 0.18).toFixed(2);
    return registrarCompra(db, f.empresaId, {
      proveedor: { ruc: RUC_CLIENTE, razonSocial: 'MADERAS DEL SUR S.A.C.' }, serie: 'F001', numero: ++numero, fecha: hoy,
      igv, total: (Number(base) + Number(igv)).toFixed(2), items: [{ sku, descripcion: sku, cantidad, costoUnitario: costo }],
    });
  };
  const venta = async (sku: string, cantidad: string) => {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual,
      solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item('200.00', cantidad, { codigo: sku, descripcion: sku })] }) });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
  };

  it('estado, días que alcanza, punto de pedido, sugerido y KPIs', async () => {
    await guardarProducto(db, f.empresaId, { sku: 'CAB-01', nombre: 'Cabecera', precio: '200.00', stockMinimo: '2' });
    await guardarProducto(db, f.empresaId, { sku: 'TAR-01', nombre: 'Tarima', precio: '200.00', stockMinimo: '1' });
    await guardarProducto(db, f.empresaId, { sku: 'ALM-01', nombre: 'Almohada', precio: '50.00' });
    await compra('CAB-01', '20', '100.00');
    await compra('CAB-01', '10', '130.00');
    await compra('TAR-01', '5', '50.00');
    await venta('CAB-01', '12');
    await venta('TAR-01', '4');
    // El proveedor tarda 10 días; la tarima, que se fabrica a pedido, 0 días.
    expect(await guardarDiasEntrega(db, f.empresaId, RUC_CLIENTE, 10)).toBe(true);
    expect(await asignarProveedor(db, f.empresaId, 'cab-01', RUC_CLIENTE, null)).toBe(true);
    expect(await asignarProveedor(db, f.empresaId, 'TAR-01', RUC_CLIENTE, 0)).toBe(true);
    expect(await asignarProveedor(db, f.empresaId, 'TAR-01', '20999999999', 0)).toBe(false);

    const r = await reposicion(db, f.empresaId, hoy);
    const de = (sku: string) => r.productos.find((p) => p.sku === sku)!;
    // Cabecera: 30 − 12 = 18; vende 0.4 al día → alcanza 45 días; pedido = 0.4 × 10 + 2 = 6.
    expect(de('CAB-01')).toMatchObject({ stock: '18', ventaDiaria: '0.4', diasQueAlcanza: 45, diasEntrega: 10, proveedor: 'MADERAS DEL SUR S.A.C.',
      puntoPedido: '6', sugerido: '0', estado: 'OK', costoPromedio: '110.00', valor: '1980.00' });
    // Tarima: queda 1 = colchón → pedir ya: 4/30 × (0 + 30) + 1 − 1 = 4.
    expect(de('TAR-01')).toMatchObject({ stock: '1', estado: 'PEDIR_YA', sugerido: '4', diasEntrega: 0 });
    expect(de('ALM-01')).toMatchObject({ stock: '0', estado: 'AGOTADO', diasEntrega: null });
    // Lo urgente primero.
    expect(r.productos.map((p) => p.estado)).toEqual(['AGOTADO', 'PEDIR_YA', 'OK']);
    // Valor = 1980 + 50; costo vendido = 12 × 110 + 4 × 50 = 1520 en 30 días → 2030 ÷ 50.67 = 40 días.
    expect(r.resumen).toEqual({ valorInventario: '2030.00', aPedir: 2, agotados: 1, sinMovimiento: 0, diasDeInventario: 40, sinTiempoEntrega: 1 });
  });

  it('Kardex valorizado a costo promedio ponderado', async () => {
    const k = await kardex(db, f.empresaId, 'cab-01');
    expect(k!.producto).toEqual({ sku: 'CAB-01', nombre: 'Cabecera' });
    expect(k!.movimientos.map((m) => [m.tipo, m.entrada, m.salida, m.saldo, m.costoPromedio, m.valorSaldo])).toEqual([
      ['COMPRA', '20', null, '20', '100.00', '2000.00'],
      ['COMPRA', '10', null, '30', '110.00', '3300.00'],
      ['VENTA', null, '12', '18', '110.00', '1980.00'],
    ]);
    expect(k!.movimientos[0]!.documento).toMatch(/^F001-1 · MADERAS DEL SUR/);
    expect(k!.movimientos[2]!.documento).toMatch(/^B001-/);
    expect(await kardex(db, f.empresaId, 'NO-EXISTE')).toBeUndefined();
  });
});
