/**
 * Caja: cada cobro dice a qué cuenta entró (Yape de la empresa, Yape de otra persona,
 * efectivo…). Se prueba que la caja separe cuentas de la empresa y de terceros, que el
 * total cuadre y que la cuenta de un pago no se pueda cambiar después.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { caja, guardarCuenta, listarCuentas } from '../../src/cobros/caja.js';
import { registrarPago } from '../../src/cobros/pagos.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('caja y cuentas de cobro', () => {
  let db: Db;
  let f: Fixture;
  let usuarioId: string;
  const hoy = ahoraLima().fecha;

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    usuarioId = (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ('caja@prueba.pe', 'Caja') RETURNING id`)).rows[0].id;
  });

  const venta = async (precio: string) => {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item(precio)] }) });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
    return r.guardado.id;
  };

  it('separa cuentas de la empresa y de otras personas; el total cuadra', async () => {
    const yapeEmpresa = await guardarCuenta(db, f.empresaId, { nombre: 'Yape de la empresa', medio: 'YAPE', deLaEmpresa: true, predeterminada: true }, usuarioId);
    const yapeMaria = await guardarCuenta(db, f.empresaId, { nombre: 'Yape de María', medio: 'YAPE', titular: 'María Quispe', deLaEmpresa: false, predeterminada: false }, usuarioId);
    await expect(guardarCuenta(db, f.empresaId, { nombre: 'yape DE la empresa', medio: 'PLIN', deLaEmpresa: true, predeterminada: false }, usuarioId)).rejects.toThrow(/mismo nombre|ese nombre/);
    await expect(guardarCuenta(db, f.empresaId, { nombre: 'X', medio: 'CHEQUE', deLaEmpresa: true, predeterminada: false }, usuarioId)).rejects.toThrow(/medio/);

    // Sin cuenta elegida: va a la predeterminada del medio.
    expect((await registrarPago(db, { empresaId: f.empresaId, comprobanteId: await venta('100.00'), medio: 'YAPE', referencia: 'Y1' })).resultado).toBe('REGISTRADO');
    expect((await registrarPago(db, { empresaId: f.empresaId, comprobanteId: await venta('40.00'), medio: 'YAPE', cuentaId: yapeMaria, referencia: 'Y2' })).resultado).toBe('REGISTRADO');
    // Efectivo sin cuenta creada: queda como "Sin cuenta: Efectivo" (de la empresa).
    expect((await registrarPago(db, { empresaId: f.empresaId, comprobanteId: await venta('25.50'), medio: 'EFECTIVO' })).resultado).toBe('REGISTRADO');
    // Pago parcial: se vendió 200 y solo entraron 50.
    expect((await registrarPago(db, { empresaId: f.empresaId, comprobanteId: await venta('200.00'), medio: 'YAPE', monto: '50.00', referencia: 'Y3' })).resultado).toBe('REGISTRADO');

    // La cuenta debe ser del mismo medio y estar activa.
    const otra = await venta('10.00');
    expect(await registrarPago(db, { empresaId: f.empresaId, comprobanteId: otra, medio: 'EFECTIVO', cuentaId: yapeMaria })).toMatchObject({ resultado: 'ERROR' });
    await guardarCuenta(db, f.empresaId, { id: yapeMaria, nombre: 'Yape de María', medio: 'YAPE', deLaEmpresa: false, predeterminada: false, activa: false }, usuarioId);
    expect(await registrarPago(db, { empresaId: f.empresaId, comprobanteId: otra, medio: 'YAPE', cuentaId: yapeMaria })).toMatchObject({ resultado: 'ERROR' });

    const c = await caja(db, f.empresaId, hoy, hoy);
    expect(c.cuentas).toEqual([
      { cuentaId: yapeEmpresa, nombre: 'Yape de la empresa', medio: 'YAPE', titular: null, deLaEmpresa: true, cobros: 2, monto: '150.00' },
      { cuentaId: yapeMaria, nombre: 'Yape de María', medio: 'YAPE', titular: 'María Quispe', deLaEmpresa: false, cobros: 1, monto: '40.00' },
      { cuentaId: null, nombre: 'Sin cuenta: Efectivo', medio: 'EFECTIVO', titular: null, deLaEmpresa: true, cobros: 1, monto: '25.50' },
    ]);
    expect(c.totales).toEqual({ empresa: '175.50', terceros: '40.00', total: '215.50', cobros: 4 });
    expect(c.vendido).toBe('375.50');
    // Otro día: vacío.
    expect((await caja(db, f.empresaId, '2020-01-01', '2020-01-31')).totales.total).toBe('0.00');
  });

  it('la cuenta de un pago no se cambia después; una sola predeterminada por medio', async () => {
    const p = (await db.query(`SELECT id FROM pagos WHERE cuenta_id IS NOT NULL LIMIT 1`)).rows[0].id;
    await expect(db.query(`UPDATE pagos SET cuenta_id = NULL WHERE id = $1`, [p])).rejects.toThrow(/no se modifica/);
    const nueva = await guardarCuenta(db, f.empresaId, { nombre: 'Yape nuevo', medio: 'YAPE', deLaEmpresa: true, predeterminada: true }, usuarioId);
    const yapes = (await listarCuentas(db, f.empresaId)).filter((c) => c.medio === 'YAPE' && c.predeterminada);
    expect(yapes.map((c) => c.id)).toEqual([nueva]);
  });
});
