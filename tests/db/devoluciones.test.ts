/**
 * Devoluciones: nota de crédito + stock + reembolso, sin devolver nunca más de lo vendido.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { caja, guardarCuenta, lineasParaCerrar } from '../../src/cobros/caja.js';
import { estadoCobro } from '../../src/cobros/pagos.js';
import { procesarCola, type ServiciosEnvio } from '../../src/cola/procesar.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { SolicitudComprobante } from '../../src/comprobantes/preparar.js';
import type { Db } from '../../src/db/conexion.js';
import { registrarDevolucion, type DatosDevolucion } from '../../src/devoluciones/devoluciones.js';
import { ahoraLima } from '../../src/fechas.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { ajustarStock, guardarProducto, listarStock } from '../../src/inventario/productos.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { item, solicitudBoleta } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('devoluciones', () => {
  let db: Db;
  let f: Fixture;
  let s: ServiciosEnvio;
  const sunat = new SunatSimulado();
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const hoy = ahoraLima().fecha;

  beforeAll(async () => {
    db = await prepararBase();
    await sunat.iniciar();
    s = {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-devoluciones-'))),
      llaveMaestra, algoritmo: 'SHA256', entorno: { SUNAT_URL_BETA: sunat.url },
      ahora: () => new Date(Date.now() + 60_000),
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales, tiempoMaximoMs: 400 }),
    };
  });
  afterAll(async () => {
    await sunat.detener();
    await db?.end();
  });
  beforeEach(async () => {
    sunat.reiniciar();
    // La cola es de todas las empresas: se vacía para que lo pendiente de la prueba
    // anterior no se lleve la respuesta simulada de SUNAT de esta.
    while ((await procesarCola(db, s)).procesados > 0);
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
    await guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba(), clave: 'clave-de-prueba', llaveMaestra });
    await guardarProducto(db, f.empresaId, { sku: 'TAR-001', nombre: 'Tarima', precio: '354.00' });
    await guardarProducto(db, f.empresaId, { sku: 'CAB-001', nombre: 'Cabecera', precio: '118.00' });
    await ajustarStock(db, f.empresaId, 'TAR-001', '10', 'inventario inicial');
    await ajustarStock(db, f.empresaId, 'CAB-001', '10', 'inventario inicial');
  });

  /** Boleta aceptada por SUNAT: 2 tarimas (354) y 1 cabecera (118) = 826.00. */
  async function venta(extra: Partial<SolicitudComprobante> = {}): Promise<string> {
    const r = await emitirComprobante(db, {
      empresaId: f.empresaId, canalId: f.canalManual,
      solicitud: solicitudBoleta({
        fechaEmision: hoy,
        items: [item('354.00', '2'), item('118.00', '1', { codigo: 'CAB-001', descripcion: 'Cabecera' })],
        ...extra,
      }),
    });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join());
    await procesarCola(db, s);
    return r.guardado.id;
  }

  const devolver = (comprobanteId: string, extra: Partial<DatosDevolucion> = {}) =>
    registrarDevolucion(db, { empresaId: f.empresaId, comprobanteId, motivo: 'Cliente desistió', items: [{ orden: 1, cantidad: '1' }], ...extra });

  const stock = async (sku: string) => (await listarStock(db, f.empresaId)).find((x) => x.sku === sku)?.stock;

  it('parcial: nota de crédito 07 por lo devuelto y el producto vuelve al stock', async () => {
    const id = await venta();
    expect(await stock('TAR-001')).toBe('8');
    const r = await devolver(id);
    expect(r).toMatchObject({ tipo: 'PARCIAL', total: '354.00', notaCredito: 'BC01-00000001' });
    const nc = await db.query(`SELECT motivo_nota_codigo, comprobante_referencia_id FROM comprobantes WHERE id = $1`, [r.notaCreditoId]);
    expect(nc.rows[0]).toEqual({ motivo_nota_codigo: '07', comprobante_referencia_id: id });
    expect(await stock('TAR-001')).toBe('9');
    expect((await estadoCobro(db, id)).saldo.toFixed(2)).toBe('472.00'); // 826 − 354
  });

  it('dañado: se emite la nota pero el producto NO vuelve al stock vendible', async () => {
    const id = await venta();
    await devolver(id, { items: [{ orden: 2, cantidad: '1', danado: true }] });
    expect(await stock('CAB-001')).toBe('9');
    const m = await db.query(`SELECT tipo::text, cantidad::int FROM movimientos_stock m JOIN productos p ON p.id = m.producto_id WHERE p.sku = 'CAB-001' AND p.empresa_id = $1 ORDER BY m.id`, [f.empresaId]);
    expect(m.rows.map((x) => `${x.tipo} ${x.cantidad}`)).toEqual(['AJUSTE 10', 'VENTA -1', 'DEVOLUCION 1', 'AJUSTE -1']);
  });

  it('nunca más de lo vendido, sumando devoluciones anteriores', async () => {
    const id = await venta();
    await devolver(id);
    await expect(devolver(id, { items: [{ orden: 1, cantidad: '2' }] })).rejects.toThrow(/solo quedan 1 por devolver/);
    await expect(devolver(id, { items: [{ orden: 9, cantidad: '1' }] })).rejects.toThrow(/no tiene la línea 9/);
    await expect(devolver(id, { motivo: '  ' })).rejects.toThrow(/motivo/);
    await devolver(id); // la segunda tarima sí
    await expect(devolver(id)).rejects.toThrow(/solo quedan 0/);
  });

  it('dos devoluciones de la misma unidad al mismo tiempo: solo una pasa', async () => {
    const id = await venta({ items: [item('354.00', '1')] });
    const r = await Promise.allSettled([devolver(id), devolver(id)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await stock('TAR-001')).toBe('10');
  });

  it('total: motivo 06 y exactamente el importe, aun con descuento global', async () => {
    const id = await venta({ descuentoGlobal: '26.00' }); // cobrado 800.00
    const r = await devolver(id, { items: [{ orden: 1, cantidad: '2' }, { orden: 2, cantidad: '1' }] });
    expect(r).toMatchObject({ tipo: 'TOTAL', total: '800.00' });
    const nc = await db.query(`SELECT motivo_nota_codigo FROM comprobantes WHERE id = $1`, [r.notaCreditoId]);
    expect(nc.rows[0].motivo_nota_codigo).toBe('06');
    expect((await estadoCobro(db, id)).saldo.toFixed(2)).toBe('0.00');
  });

  it('parcial con descuento: se devuelve lo pagado, no el precio de lista', async () => {
    const id = await venta({ descuentoGlobal: '82.60' }); // 10 %: cobrado 743.40
    const r = await devolver(id, { items: [{ orden: 2, cantidad: '1' }] });
    expect(r.total).toBe('106.20'); // 118.00 − 10 %
  });

  it('reembolso: se registra con su medio; no puede pasar de la nota', async () => {
    const id = await venta();
    await expect(devolver(id, { reembolso: { medio: 'YAPE', monto: '400.00' } })).rejects.toThrow(/no pasar de la nota/);
    const r = await devolver(id, { reembolso: { medio: 'YAPE', referencia: 'OP-9' } });
    const q = await db.query(`SELECT monto::text, medio::text, referencia FROM reembolsos WHERE devolucion_id = $1`, [r.devolucionId]);
    expect(q.rows[0]).toEqual({ monto: '354.00', medio: 'YAPE', referencia: 'OP-9' });
    await expect(db.query(`DELETE FROM reembolsos WHERE devolucion_id = $1`, [r.devolucionId])).rejects.toThrow();
  });

  // El dueño vio que las devoluciones no se restaban en la Caja: el dinero devuelto sale de
  // la cuenta (la elegida o la predeterminada del medio) como un gasto, y el cierre lo descuenta.
  it('reembolso: la Caja y el cierre lo restan de la cuenta de donde salió', async () => {
    const u = (await db.query(`INSERT INTO usuarios (email, nombre, password_hash) VALUES ($1, 'Caja', 'x') RETURNING id`, [`caja${Date.now()}@prueba.pe`])).rows[0].id as string;
    const cuenta = await guardarCuenta(db, f.empresaId, { nombre: `Cajón ${Date.now()}`, medio: 'EFECTIVO', deLaEmpresa: true, predeterminada: true }, u);
    const id = await venta();
    await devolver(id, { reembolso: { medio: 'EFECTIVO' } });
    const hoy = ahoraLima().fecha;
    const fila = (await caja(db, f.empresaId, hoy, hoy)).cuentas.find((x) => x.cuentaId === cuenta);
    expect(fila).toMatchObject({ gastos: '354.00' });
    const linea = (await lineasParaCerrar(db, f.empresaId, hoy)).find((l) => l.cuentaId === cuenta);
    expect(linea?.esperado.startsWith('-')).toBe(true);
  });

  it('solo sobre comprobantes aceptados por SUNAT', async () => {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy }) });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error();
    await expect(devolver(r.guardado.id)).rejects.toThrow(/cuando SUNAT lo haya aceptado/);
  });

  it('si SUNAT rechaza la nota de crédito, el stock vuelve a como estaba y se puede devolver otra vez', async () => {
    const id = await venta();
    sunat.colaBill.push({ modo: 'fault', codigo: '2800', mensaje: 'rechazo' });
    await devolver(id, { items: [{ orden: 2, cantidad: '1', danado: true }] });
    await procesarCola(db, s); // la nota sale rechazada
    expect(await stock('CAB-001')).toBe('9'); // como tras la venta
    const r = await devolver(id, { items: [{ orden: 2, cantidad: '1' }] });
    expect(r.notaCredito).toBe('BC01-00000002');
    expect(await stock('CAB-001')).toBe('10');
  });

  it('venta rechazada por SUNAT: su stock se revierte (antes quedaba descontado)', async () => {
    sunat.colaBill.push({ modo: 'fault', codigo: '2800', mensaje: 'rechazo' });
    await venta();
    expect(await stock('TAR-001')).toBe('10');
    expect(await stock('CAB-001')).toBe('10');
  });
});
