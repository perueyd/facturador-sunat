/**
 * Tablero del panel: vencimiento según el cronograma OFICIAL de SUNAT y resumen del mes.
 * Un día de error en la fecha de vencimiento es una multa; por eso se prueba con fechas reales.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { registrarCompra } from '../../src/inventario/compras.js';
import { guardarProducto } from '../../src/inventario/productos.js';
import { grupoCronograma, tablero } from '../../src/reportes/tablero.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { RUC_CLIENTE, item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase } from './base-prueba.js';

/** RUC válido que termina en el dígito pedido. */
function rucTerminadoEn(d: number): string {
  for (;;) {
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    if (digitoVerificadorRuc(base) === d) return base + d;
  }
}

describe('grupo del cronograma', () => {
  it('según el último dígito del RUC', () => {
    expect(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => grupoCronograma(`2061661307${d}`, false)))
      .toEqual(['0', '1', '2-3', '2-3', '4-5', '4-5', '6-7', '6-7', '8-9', '8-9']);
    expect(grupoCronograma('20616613074', true)).toBe('BC');
  });
});

describe.skipIf(!URL_PRUEBAS)('tablero', () => {
  let db: Db;
  beforeAll(async () => {
    db = await prepararBase();
  });

  it('próximo vencimiento con el cronograma 2026 (RUC terminado en 4)', async () => {
    const { empresaId } = await crearEmpresa(db, rucTerminadoEn(4));
    // 27/10/2026: toca declarar octubre, vence el jueves 19/11 (columna "4 y 5").
    expect((await tablero(db, empresaId, { hoy: '2026-10-27' })).vencimiento).toMatchObject({ periodo: '2026-10', vence: '2026-11-19', dias: 23, grupo: '4-5' });
    // El mismo día del vencimiento sigue siendo ese (0 días).
    expect((await tablero(db, empresaId, { hoy: '2026-11-19' })).vencimiento).toMatchObject({ periodo: '2026-10', dias: 0 });
    // Al día siguiente ya es noviembre: vence el 22/12.
    expect((await tablero(db, empresaId, { hoy: '2026-11-20' })).vencimiento).toMatchObject({ periodo: '2026-11', vence: '2026-12-22' });
    // Diciembre vence en enero 2027.
    expect((await tablero(db, empresaId, { hoy: '2026-12-23' })).vencimiento).toMatchObject({ periodo: '2026-12', vence: '2027-01-21' });
    // Sin cronograma cargado para 2027: lo avisa en vez de inventar una fecha.
    expect((await tablero(db, empresaId, { hoy: '2027-02-01' })).vencimiento).toEqual({ faltaCronograma: true });
  });

  it('buen contribuyente usa su propia columna', async () => {
    const { empresaId } = await crearEmpresa(db, rucTerminadoEn(0));
    expect((await tablero(db, empresaId, { hoy: '2026-10-27' })).vencimiento).toMatchObject({ vence: '2026-11-16' });
    await db.query(`UPDATE empresas SET buen_contribuyente = true WHERE id = $1`, [empresaId]);
    expect((await tablero(db, empresaId, { hoy: '2026-10-27' })).vencimiento).toMatchObject({ vence: '2026-11-24', grupo: 'BC' });
  });

  it('resumen del mes: IGV de ventas menos IGV de compras; pago a cuenta MYPE estimado', async () => {
    const ruc = rucTerminadoEn(7);
    const f = await crearEmpresa(db, ruc);
    const hoy = ahoraLima().fecha;
    const mes = hoy.slice(0, 7);
    // Mirar el tablero el último día del mes: así el próximo vencimiento es el de ESTE mes.
    const [a, m] = mes.split('-').map(Number) as [number, number];
    const ultimoDia = new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
    const siguiente = new Date(Date.UTC(a, m, 15)).toISOString().slice(0, 10);
    await db.query(`INSERT INTO cronograma_mensual VALUES ($1, '6-7', $2, 'prueba') ON CONFLICT DO NOTHING`, [mes, siguiente]);

    const r1 = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item('118.00', '2')] }) });
    const r2 = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item('59.00', '1')] }) });
    if (r1.resultado === 'ERROR_VALIDACION' || r2.resultado === 'ERROR_VALIDACION') throw new Error('no emitió');
    // Un rechazado no cuenta como venta.
    await db.query(`UPDATE comprobantes SET estado = 'RECHAZADO' WHERE id = $1`, [r2.guardado.id]);
    await guardarProducto(db, f.empresaId, { sku: 'TAR-001', nombre: 'Madera', precio: '59.00' });
    await registrarCompra(db, f.empresaId, {
      proveedor: { ruc: RUC_CLIENTE, razonSocial: 'MADERAS DEL SUR S.A.C.' }, serie: 'F001', numero: 1, fecha: hoy,
      igv: '9.00', total: '59.00', items: [{ sku: 'TAR-001', descripcion: 'Madera', cantidad: '1', costoUnitario: '50.00' }],
    });

    const t = await tablero(db, f.empresaId, { hoy: ultimoDia });
    expect(t.resumen).toMatchObject({
      periodo: mes, ventas: '236.00', baseImponible: '200.00', igvVentas: '36.00', igvCompras: '9.00', igvPorPagar: '27.00', saldoAFavor: '0.00',
      rentaPagoCuenta: { monto: '2.00', tasa: '1', porVerificar: true }, estimado: true,
    });
    expect(t.cobros).toMatchObject({ comprobantes: 1, saldo: '236.00' });
    expect(t.sunat).toMatchObject({ pendientes: 1, rechazados: 1 });
    expect(t.certificado).toEqual({ falta: true });

    // Funciones desactivadas: no se calculan.
    const solo = await tablero(db, f.empresaId, { hoy: ultimoDia, modulos: ['panel', 'vencimientos'] });
    expect(solo.resumen).toBeUndefined();
    expect(solo.cobros).toBeUndefined();
    expect(solo.vencimiento).toBeDefined();
  });

  it('las 84 fechas del cronograma 2026 son días hábiles (lunes a viernes)', async () => {
    const r = await db.query(`SELECT periodo, grupo, vence FROM cronograma_mensual WHERE periodo LIKE '2026-%' AND fuente LIKE 'Anexo I%'`);
    expect(r.rows).toHaveLength(84);
    for (const x of r.rows) expect([0, 6]).not.toContain(new Date(x.vence).getUTCDay());
  });
});
