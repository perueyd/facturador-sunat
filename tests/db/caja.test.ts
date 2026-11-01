/**
 * Caja: cada cobro dice a qué cuenta entró (Yape de la empresa, Yape de otra persona,
 * efectivo…). Se prueba que la caja separe cuentas de la empresa y de terceros, que el
 * total cuadre y que la cuenta de un pago no se pueda cambiar después.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { caja, cerrarCaja, cierresDeCaja, guardarCuenta, lineasParaCerrar, listarCuentas } from '../../src/cobros/caja.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { FOTO_MAXIMO_BYTES, anularGasto, fotoDeGasto, gastosDelPeriodo, guardarFotoGasto, registrarGasto } from '../../src/cobros/gastos.js';
import { registrarPago } from '../../src/cobros/pagos.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { item, solicitudBoleta } from '../ayudantes.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
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
      { cuentaId: yapeEmpresa, nombre: 'Yape de la empresa', medio: 'YAPE', titular: null, deLaEmpresa: true, cobros: 2, monto: '150.00', gastos: '0.00', neto: '150.00' },
      { cuentaId: yapeMaria, nombre: 'Yape de María', medio: 'YAPE', titular: 'María Quispe', deLaEmpresa: false, cobros: 1, monto: '40.00', gastos: '0.00', neto: '40.00' },
      { cuentaId: null, nombre: 'Sin cuenta: Efectivo', medio: 'EFECTIVO', titular: null, deLaEmpresa: true, cobros: 1, monto: '25.50', gastos: '0.00', neto: '25.50' },
    ]);
    expect(c.totales).toEqual({ empresa: '175.50', terceros: '40.00', total: '215.50', cobros: 4, gastos: '0.00', neto: '215.50' });
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

  it('cierre de caja: lo esperado lo pone el servidor, la diferencia queda guardada y el último cierre manda', async () => {
    const lineas = await lineasParaCerrar(db, f.empresaId, hoy);
    // Las cuentas activas sin cobros también se cuentan (S/ 0 esperado).
    expect(lineas.find((l) => l.nombre === 'Yape nuevo')).toMatchObject({ esperado: '0.00' });
    const efectivo = lineas.find((l) => l.clave === 'SIN:EFECTIVO');
    expect(efectivo).toMatchObject({ cuentaId: null, esperado: '25.50' });

    const contados = Object.fromEntries(lineas.map((l) => [l.clave, l.esperado]));
    await expect(cerrarCaja(db, f.empresaId, hoy, { ...contados, 'SIN:EFECTIVO': undefined as unknown as string }, null, usuarioId, hoy)).rejects.toThrow(/Falta.*Efectivo/);
    await expect(cerrarCaja(db, f.empresaId, hoy, { ...contados, 'SIN:EFECTIVO': '20,50' }, null, usuarioId, hoy)).rejects.toThrow(/monto contado/);
    await expect(cerrarCaja(db, f.empresaId, '2999-01-01', contados, null, usuarioId, hoy)).rejects.toThrow(/aún no llega/);

    // Faltan S/ 5.50 en el cajón.
    const primero = await cerrarCaja(db, f.empresaId, hoy, { ...contados, 'SIN:EFECTIVO': '20' }, 'faltó sencillo', usuarioId, hoy);
    expect(primero.lineas.find((l) => l.clave === 'SIN:EFECTIVO')).toMatchObject({ esperado: '25.50', contado: '20.00', diferencia: '-5.50' });
    expect(primero.totales.diferencia).toBe('-5.50');
    expect(primero).toMatchObject({ cerradoPor: 'Caja', nota: 'faltó sencillo', fecha: hoy });

    // Se volvió a contar: el nuevo cierre va primero y el anterior queda de historial.
    const segundo = await cerrarCaja(db, f.empresaId, hoy, contados, null, usuarioId, hoy);
    expect(segundo.totales.diferencia).toBe('0.00');
    expect((await cierresDeCaja(db, f.empresaId, hoy, hoy)).map((x) => x.id)).toEqual([segundo.id, primero.id]);
    // Un cierre no se cambia ni se borra.
    await expect(db.query(`UPDATE cierre_caja_lineas SET contado = 25.50 WHERE cierre_id = $1`, [primero.id])).rejects.toThrow();
    await expect(db.query(`DELETE FROM cierres_caja WHERE id = $1`, [primero.id])).rejects.toThrow();
  });

  it('gastos: se restan de la cuenta de donde salió el dinero y el cierre espera cobros − gastos', async () => {
    const otroDia = '2020-03-02';
    await expect(registrarGasto(db, f.empresaId, { fecha: hoy, monto: '0', categoria: 'TRANSPORTE', descripcion: 'x', medio: 'EFECTIVO' }, usuarioId, hoy)).rejects.toThrow(/monto/);
    await expect(registrarGasto(db, f.empresaId, { fecha: '2999-01-01', monto: '5', categoria: 'TRANSPORTE', descripcion: 'x', medio: 'EFECTIVO' }, usuarioId, hoy)).rejects.toThrow(/fecha/);
    await expect(registrarGasto(db, f.empresaId, { fecha: hoy, monto: '5', categoria: 'CASINO', descripcion: 'x', medio: 'EFECTIVO' }, usuarioId, hoy)).rejects.toThrow(/categoría/);
    const yape = (await listarCuentas(db, f.empresaId)).find((k) => k.medio === 'YAPE' && k.activa && k.predeterminada)!;
    await expect(registrarGasto(db, f.empresaId, { fecha: hoy, monto: '5', categoria: 'OTROS', descripcion: 'x', medio: 'EFECTIVO', cuentaId: yape.id }, usuarioId, hoy)).rejects.toThrow(/es de YAPE/);

    // Del efectivo (sin cuenta) salieron 10.50 en pasajes; de un día sin cobros salieron 30.
    const pasaje = await registrarGasto(db, f.empresaId, { fecha: hoy, monto: '10.50', categoria: 'TRANSPORTE', descripcion: 'Pasaje a Gamarra', medio: 'EFECTIVO' }, usuarioId, hoy);
    await registrarGasto(db, f.empresaId, { fecha: otroDia, monto: '30', categoria: 'SERVICIOS', descripcion: 'Luz', medio: 'EFECTIVO' }, usuarioId, hoy);
    const c = await caja(db, f.empresaId, hoy, hoy);
    expect(c.cuentas.find((x) => x.medio === 'EFECTIVO' && !x.cuentaId)).toMatchObject({ monto: '25.50', gastos: '10.50', neto: '15.00' });
    expect(c.totales).toMatchObject({ total: '215.50', gastos: '10.50', neto: '205.00' });
    expect((await lineasParaCerrar(db, f.empresaId, hoy)).find((l) => l.clave === 'SIN:EFECTIVO')?.esperado).toBe('15.00');
    // Un día solo con gastos también sale en la caja (en negativo: hubo que poner plata).
    expect((await caja(db, f.empresaId, otroDia, otroDia)).cuentas).toEqual([expect.objectContaining({ monto: '0.00', gastos: '30.00', neto: '-30.00', cobros: 0 })]);

    // Anular: pide motivo, una sola vez, y deja de restar. No se borra ni se cambia.
    await expect(anularGasto(db, f.empresaId, pasaje, '', usuarioId)).rejects.toThrow(/por qué/);
    expect(await anularGasto(db, f.empresaId, pasaje, 'Lo pagó el cliente', usuarioId)).toBe(true);
    expect(await anularGasto(db, f.empresaId, pasaje, 'otra vez', usuarioId)).toBe(false);
    expect((await caja(db, f.empresaId, hoy, hoy)).totales.gastos).toBe('0.00');
    await expect(db.query(`DELETE FROM gastos WHERE id = $1`, [pasaje])).rejects.toThrow(/no se borra/);
    await expect(db.query(`UPDATE gastos SET monto = 1 WHERE id = $1`, [pasaje])).rejects.toThrow(/no se modifica/);

    const p = await gastosDelPeriodo(db, f.empresaId, '2020-01-01', hoy);
    expect(p.total).toBe('30.00');
    expect(p.porCategoria).toEqual([{ categoria: 'SERVICIOS', nombre: 'Luz, agua, internet', monto: '30.00', ancho: 100 }]);
    expect(p.gastos.find((g) => g.id === pasaje)?.anulado).toMatchObject({ motivo: 'Lo pagó el cliente', por: 'Caja' });
  });

  it('fondo inicial: el cajón empieza con lo que quedó en el último cierre; se puede corregir', async () => {
    const g = await crearEmpresa(db, `2060000008${digitoVerificadorRuc('2060000008')}`);
    const cajon = await guardarCuenta(db, g.empresaId, { nombre: 'Cajón', medio: 'EFECTIVO', deLaEmpresa: true, predeterminada: true }, usuarioId);
    // Día 1: se dejan S/ 50 de sencillo en el cajón.
    expect((await lineasParaCerrar(db, g.empresaId, '2020-05-01'))[0]).toMatchObject({ clave: cajon, esperado: '0.00', fondoSugerido: '0.00' });
    await cerrarCaja(db, g.empresaId, '2020-05-01', { [cajon]: '50' }, 'fondo de sencillo', usuarioId, hoy);
    // Día 2: se pagan S/ 20 de un pasaje con el cajón. Debería haber 50 − 20 = 30.
    await registrarGasto(db, g.empresaId, { fecha: '2020-05-02', monto: '20', categoria: 'TRANSPORTE', descripcion: 'Pasaje', medio: 'EFECTIVO', cuentaId: cajon }, usuarioId, hoy);
    expect((await lineasParaCerrar(db, g.empresaId, '2020-05-02'))[0]).toMatchObject({ esperado: '-20.00', fondoSugerido: '50.00' });
    const cuadra = await cerrarCaja(db, g.empresaId, '2020-05-02', { [cajon]: '30' }, null, usuarioId, hoy);
    expect(cuadra.lineas[0]).toMatchObject({ fondo: '50.00', esperado: '-20.00', deberiaHaber: '30.00', contado: '30.00', diferencia: '0.00' });
    expect(cuadra.totales).toMatchObject({ fondo: '50.00', deberiaHaber: '30.00', diferencia: '0.00' });
    // Si en realidad empezó con 40, se corrige el fondo: sobran 10.
    const corregido = await cerrarCaja(db, g.empresaId, '2020-05-02', { [cajon]: '30' }, null, usuarioId, hoy, { [cajon]: '40' });
    expect(corregido.lineas[0]).toMatchObject({ fondo: '40.00', deberiaHaber: '20.00', diferencia: '10.00' });
    await expect(cerrarCaja(db, g.empresaId, '2020-05-02', { [cajon]: '30' }, null, usuarioId, hoy, { [cajon]: '4,0' })).rejects.toThrow(/fondo inicial/);
  });

  it('foto del recibo: una por gasto, solo JPG o PNG, y queda guardada como sustento', async () => {
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'fotos-')));
    const gasto = await registrarGasto(db, f.empresaId, { fecha: hoy, monto: '15', categoria: 'INSUMOS', descripcion: 'Tornillos', medio: 'EFECTIVO' }, usuarioId, hoy);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
    await expect(guardarFotoGasto(db, almacen, f.empresaId, gasto, Buffer.from('no es imagen'), usuarioId)).rejects.toThrow(/JPG o PNG/);
    await expect(guardarFotoGasto(db, almacen, f.empresaId, gasto, Buffer.concat([png, Buffer.alloc(FOTO_MAXIMO_BYTES)]), usuarioId)).rejects.toThrow(/pesada/);
    expect(await fotoDeGasto(db, almacen, f.empresaId, gasto)).toBeUndefined();
    await guardarFotoGasto(db, almacen, f.empresaId, gasto, png, usuarioId);
    expect(await fotoDeGasto(db, almacen, f.empresaId, gasto)).toEqual({ datos: png, tipo: 'image/png' });
    await expect(guardarFotoGasto(db, almacen, f.empresaId, gasto, png, usuarioId)).rejects.toThrow(/ya tiene su foto/);
    expect((await gastosDelPeriodo(db, f.empresaId, hoy, hoy)).gastos.find((g) => g.id === gasto)?.foto).toBe(true);
    // Se conserva al menos 5 años, como todo sustento.
    expect((await db.query(`SELECT tipo, conservar_hasta >= current_date + interval '5 years' AS cinco FROM archivos WHERE entidad = 'gastos' AND entidad_id = $1`, [gasto])).rows[0]).toEqual({ tipo: 'SUSTENTO', cinco: true });
  });
});
