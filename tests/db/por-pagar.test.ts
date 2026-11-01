/**
 * Cuentas por pagar: una compra al crédito queda como deuda hasta pagarla (en partes si hace
 * falta), avisa lo vencido y lo que vence en 7 días, no deja pagar de más, y cada pago sale
 * de una cuenta, así que la caja y el cierre lo restan.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { caja, guardarCuenta } from '../../src/cobros/caja.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima, sumarDias } from '../../src/fechas.js';
import { registrarCompra, type DatosCompra } from '../../src/inventario/compras.js';
import { anularPagoCompra, pagarCompra, porPagar } from '../../src/inventario/por-pagar.js';
import { tablero } from '../../src/reportes/tablero.js';
import { RUC_CLIENTE } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('cuentas por pagar', () => {
  let db: Db;
  let f: Fixture;
  let usuarioId: string;
  const hoy = ahoraLima().fecha;
  const compra = (numero: number, total: string, igv: string, base: string, extra: Partial<DatosCompra> = {}): DatosCompra => ({
    proveedor: { ruc: RUC_CLIENTE, razonSocial: 'MADERAS DEL SUR S.A.C.' }, serie: 'F001', numero, fecha: sumarDias(hoy, -20),
    igv, total, items: [{ descripcion: 'Melamina', cantidad: '1', costoUnitario: base }], ...extra,
  });

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    usuarioId = (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ('pagar@prueba.pe', 'Pagos') RETURNING id`)).rows[0].id;
  });

  it('compras al crédito: saldo, vencidas y por vencer; las de contado no aparecen', async () => {
    await expect(registrarCompra(db, f.empresaId, compra(1, '118.00', '18.00', '100.00', { vence: sumarDias(hoy, -30) }))).rejects.toThrow(/vencimiento/);
    const contado = await registrarCompra(db, f.empresaId, compra(1, '118.00', '18.00', '100.00'));
    const vencida = await registrarCompra(db, f.empresaId, compra(2, '590.00', '90.00', '500.00', { vence: sumarDias(hoy, -1) }));
    await registrarCompra(db, f.empresaId, compra(3, '236.00', '36.00', '200.00', { vence: sumarDias(hoy, 5) }));
    await registrarCompra(db, f.empresaId, compra(4, '1180.00', '180.00', '1000.00', { vence: sumarDias(hoy, 30) }));

    const r = await porPagar(db, f.empresaId, hoy);
    expect(r.deudas.map((x) => [x.documento, x.estado, x.saldo])).toEqual([
      ['F001-2', 'VENCIDA', '590.00'], ['F001-3', 'VENCE_PRONTO', '236.00'], ['F001-4', 'AL_DIA', '1180.00'],
    ]);
    expect(r.resumen).toEqual({ total: '2006.00', vencido: '590.00', vencePronto: '236.00', proveedores: 1 });
    await expect(pagarCompra(db, f.empresaId, contado.compraId, { medio: 'EFECTIVO', fecha: hoy }, usuarioId, hoy)).rejects.toThrow(/al contado/);
    expect((await tablero(db, f.empresaId, { hoy, porPagar: true })).porPagar).toEqual({ saldo: '2006.00', vencido: '590.00', vencePronto: '236.00' });
    expect((await tablero(db, f.empresaId, { hoy })).porPagar).toBeUndefined();

    // Pago parcial desde el cajón, luego no se puede pagar de más, luego se paga el resto.
    const cajon = await guardarCuenta(db, f.empresaId, { nombre: 'Cajón', medio: 'EFECTIVO', deLaEmpresa: true, predeterminada: true }, usuarioId);
    const p1 = await pagarCompra(db, f.empresaId, vencida.compraId, { monto: '200', medio: 'EFECTIVO', cuentaId: cajon, fecha: hoy }, usuarioId, hoy);
    expect(p1.saldo).toBe('390.00');
    await expect(pagarCompra(db, f.empresaId, vencida.compraId, { monto: '400', medio: 'EFECTIVO', fecha: hoy }, usuarioId, hoy)).rejects.toThrow(/supera el saldo/);
    await expect(pagarCompra(db, f.empresaId, vencida.compraId, { medio: 'YAPE', cuentaId: cajon, fecha: hoy }, usuarioId, hoy)).rejects.toThrow(/es de EFECTIVO/);
    // La caja del día resta lo pagado al proveedor.
    expect((await caja(db, f.empresaId, hoy, hoy)).cuentas.find((x) => x.cuentaId === cajon)).toMatchObject({ gastos: '200.00', neto: '-200.00' });

    expect((await pagarCompra(db, f.empresaId, vencida.compraId, { medio: 'TRANSFERENCIA', fecha: hoy, referencia: 'OP-1' }, usuarioId, hoy)).saldo).toBe('0.00');
    expect((await porPagar(db, f.empresaId, hoy)).deudas.map((x) => x.documento)).toEqual(['F001-3', 'F001-4']);
    await expect(pagarCompra(db, f.empresaId, vencida.compraId, { medio: 'EFECTIVO', fecha: hoy }, usuarioId, hoy)).rejects.toThrow(/ya está pagada/);

    // Anular el pago devuelve la deuda; no se borra ni se cambia.
    await expect(anularPagoCompra(db, f.empresaId, p1.id, '', usuarioId)).rejects.toThrow(/por qué/);
    expect(await anularPagoCompra(db, f.empresaId, p1.id, 'Se registró dos veces', usuarioId)).toBe(true);
    expect((await porPagar(db, f.empresaId, hoy)).deudas[0]).toMatchObject({ documento: 'F001-2', saldo: '200.00', pagado: '390.00' });
    await expect(db.query(`DELETE FROM pagos_compra WHERE id = $1`, [p1.id])).rejects.toThrow(/no se borra/);
  });
});
