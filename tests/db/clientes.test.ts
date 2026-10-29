/**
 * Clientes frecuentes y su celular para WhatsApp: se prueba el orden (quién compra más),
 * que las notas de crédito resten, el saldo pendiente y que el celular quede como lo pide
 * wa.me (solo dígitos con código de país).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { registrarPago } from '../../src/cobros/pagos.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { clientesFrecuentes, guardarCelular, normalizarCelular } from '../../src/reportes/cliente.js';
import { item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe('celular para WhatsApp', () => {
  it('acepta celulares de Perú y de otros países con su código; rechaza lo demás', () => {
    expect(normalizarCelular('987 654 321')).toBe('51987654321');
    expect(normalizarCelular('+51 987-654-321')).toBe('51987654321');
    expect(normalizarCelular('0051987654321')).toBe('51987654321');
    expect(normalizarCelular('+34 612 345 678')).toBe('34612345678');
    expect(normalizarCelular('01 234 5678')).toBeUndefined(); // fijo de Lima: no tiene WhatsApp
    expect(normalizarCelular('87654321')).toBeUndefined();
    expect(normalizarCelular('9876543210')).toBeUndefined();
    expect(normalizarCelular('hola')).toBeUndefined();
  });
});

describe.skipIf(!URL_PRUEBAS)('clientes frecuentes', () => {
  let db: Db;
  let f: Fixture;
  let usuarioId: string;
  const hoy = ahoraLima().fecha;

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    usuarioId = (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ('clientes@prueba.pe', 'Clientes') RETURNING id`)).rows[0].id;
  });

  const venta = async (precio: string, numeroDoc: string, nombre: string) => {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item(precio)], cliente: { tipoDoc: '1', numeroDoc, nombre } }) });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
    return r.guardado.id;
  };

  it('ordena por cuántas veces compra, con total, última compra y saldo', async () => {
    const a = await venta('100.00', '11111111', 'ANA');
    await venta('50.00', '11111111', 'ANA');
    await venta('500.00', '22222222', 'BETO');
    await registrarPago(db, { empresaId: f.empresaId, comprobanteId: a, medio: 'EFECTIVO' });

    const lista = await clientesFrecuentes(db, f.empresaId, hoy);
    expect(lista.map((x) => x.nombre)).toEqual(['ANA', 'BETO']);
    expect(lista[0]).toMatchObject({ compras: 2, totalComprado: '150.00', saldoPendiente: '50.00', ultimaCompra: hoy, diasSinComprar: 0, celular: null });
    expect(lista[1]).toMatchObject({ compras: 1, totalComprado: '500.00', saldoPendiente: '500.00' });
  });

  it('guarda y borra el celular; un cliente que no existe no se toca', async () => {
    expect(await guardarCelular(db, f.empresaId, { tipoDocumento: '1', numero: '11111111' }, '51987654321', usuarioId)).toBe(true);
    expect((await clientesFrecuentes(db, f.empresaId, hoy))[0]?.celular).toBe('51987654321');
    expect(await guardarCelular(db, f.empresaId, { tipoDocumento: '6', numero: '11111111' }, '51987654321', usuarioId)).toBe(false);
    expect(await guardarCelular(db, f.empresaId, { tipoDocumento: '1', numero: '11111111' }, null, usuarioId)).toBe(true);
    expect((await clientesFrecuentes(db, f.empresaId, hoy))[0]?.celular).toBeNull();
  });
});
