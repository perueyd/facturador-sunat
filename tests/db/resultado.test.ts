/**
 * Resultado del mes (estimado): ventas sin IGV − compras sin IGV − gastos. Las notas de
 * crédito restan venta; lo anulado o rechazado no cuenta; sin las funciones de compras o de
 * caja, esos montos no se restan.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { anularGasto, registrarGasto } from '../../src/cobros/gastos.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { SolicitudComprobante } from '../../src/comprobantes/preparar.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { registrarCompra } from '../../src/inventario/compras.js';
import { resultadoDelMes } from '../../src/reportes/resultado.js';
import { TipoComprobante } from '../../src/tipos.js';
import { RUC_CLIENTE, item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('resultado del mes', () => {
  let db: Db;
  let f: Fixture;
  let usuarioId: string;
  const hoy = ahoraLima().fecha;
  const mes = hoy.slice(0, 7);

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    usuarioId = (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ('resultado@prueba.pe', 'R') RETURNING id`)).rows[0].id;
  });

  const emitir = async (s: SolicitudComprobante) => {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: s });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
    return r.guardado.id;
  };

  it('ventas − compras − gastos, sin IGV en ventas y compras', async () => {
    expect(await resultadoDelMes(db, f.empresaId, mes, { compras: true, gastos: true }))
      .toEqual({ mes, ventas: '0.00', compras: '0.00', gastos: '0.00', resultado: '0.00', margen: null, estimado: true });

    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('118.00')] }));          // base 100
    await emitir({
      ...solicitudBoleta({ fechaEmision: hoy, items: [item('11.80')] }),                       // base 10, resta
      tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01',
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo: '07', motivoDescripcion: 'Devolución' },
    });
    const rechazada = await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('999.00')] }));
    await db.query(`UPDATE comprobantes SET estado = 'RECHAZADO' WHERE id = $1`, [rechazada]);
    await registrarCompra(db, f.empresaId, {
      proveedor: { ruc: RUC_CLIENTE, razonSocial: 'PROVEEDOR S.A.C.' }, serie: 'F001', numero: 1, fecha: hoy,
      igv: '9.00', total: '59.00', items: [{ descripcion: 'Tela', cantidad: '1', costoUnitario: '50.00' }],
    });
    await registrarGasto(db, f.empresaId, { fecha: hoy, monto: '5', categoria: 'TRANSPORTE', descripcion: 'Pasaje', medio: 'EFECTIVO' }, usuarioId, hoy);
    const anulado = await registrarGasto(db, f.empresaId, { fecha: hoy, monto: '1000', categoria: 'OTROS', descripcion: 'Error', medio: 'EFECTIVO' }, usuarioId, hoy);
    await anularGasto(db, f.empresaId, anulado, 'Error de digitación', usuarioId);

    // 90 − 50 − 5 = 35 → 35 / 90 = 38.9 %
    expect(await resultadoDelMes(db, f.empresaId, mes, { compras: true, gastos: true }))
      .toEqual({ mes, ventas: '90.00', compras: '50.00', gastos: '5.00', resultado: '35.00', margen: '38.9', estimado: true });
    // Sin las funciones de compras ni de caja, solo cuentan las ventas.
    expect((await resultadoDelMes(db, f.empresaId, mes, { compras: false, gastos: false })).resultado).toBe('90.00');
  });
});
