/**
 * Fase 7 — Cobros: pagos, saldo, cuotas, vencimientos y resumen del día.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { crearLlaveApi } from '../../src/api/llaves.js';
import { anularPago, estadoCobro, registrarPago, revisarVencimientos, type NuevoPago } from '../../src/cobros/pagos.js';
import { procesarCola, type ServiciosEnvio } from '../../src/cola/procesar.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima, sumarDias } from '../../src/fechas.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { resumenDelDia } from '../../src/reportes/resumen-dia.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { TipoComprobante } from '../../src/tipos.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { item, solicitudBoleta, solicitudFactura } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('cobros', () => {
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
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-cobros-'))),
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
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
    await guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba(), clave: 'clave-de-prueba', llaveMaestra });
  });

  async function emitir(solicitud = solicitudBoleta({ fechaEmision: hoy, items: [item('100.00', '3')] })): Promise<string> {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalTienda, solicitud });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join());
    return r.guardado.id;
  }
  const pagar = (comprobanteId: string, extra: Partial<NuevoPago> = {}) =>
    registrarPago(db, { empresaId: f.empresaId, comprobanteId, medio: 'YAPE', ...extra });
  const estadoPago = async (id: string) => (await db.query(`SELECT estado_pago FROM comprobantes WHERE id = $1`, [id])).rows[0].estado_pago;

  it('pago parcial y luego total: PENDIENTE → PARCIAL → PAGADO', async () => {
    const id = await emitir();
    expect(await estadoPago(id)).toBe('PENDIENTE');
    const a = await pagar(id, { monto: '120.50', referencia: 'OP-1' });
    expect(a).toMatchObject({ resultado: 'REGISTRADO' });
    if (a.resultado !== 'ERROR') expect(a.cobro.saldo.toFixed(2)).toBe('179.50');
    expect(await estadoPago(id)).toBe('PARCIAL');
    const b = await pagar(id, { medio: 'EFECTIVO' }); // sin monto: cobra el saldo
    if (b.resultado !== 'ERROR') expect(b.cobro).toMatchObject({ estadoPago: 'PAGADO' });
    expect(await estadoPago(id)).toBe('PAGADO');
    expect(await pagar(id, { monto: '1.00', medio: 'EFECTIVO' })).toEqual({ resultado: 'ERROR', errores: [expect.stringMatching(/ya está pagado/)] });
  });

  it('no permite pagar más que el saldo, montos inválidos ni fechas futuras', async () => {
    const id = await emitir();
    expect(await pagar(id, { monto: '300.01' })).toEqual({ resultado: 'ERROR', errores: [expect.stringMatching(/supera el saldo .* \(S\/ 300\.00\)/)] });
    expect((await pagar(id, { monto: '10,50' })).resultado).toBe('ERROR');
    expect((await pagar(id, { monto: '1.001' })).resultado).toBe('ERROR');
    expect((await pagar(id, { monto: '1.00', fecha: '2099-01-01' })).resultado).toBe('ERROR');
    expect((await pagar(id, { medio: 'BITCOIN' as 'YAPE' })).resultado).toBe('ERROR');
  });

  it('la misma operación Yape dos veces no se registra dos veces', async () => {
    const id = await emitir();
    const a = await pagar(id, { monto: '100.00', referencia: '987654' });
    const b = await pagar(id, { monto: '100.00', referencia: '987654' });
    expect(b.resultado).toBe('REPETIDO');
    if (a.resultado !== 'ERROR' && b.resultado !== 'ERROR') expect(b.pagoId).toBe(a.pagoId);
    expect((await estadoCobro(db, id)).pagado.toFixed(2)).toBe('100.00');
    // La misma operación no puede pagar OTRO comprobante.
    const otro = await emitir();
    expect(await pagar(otro, { monto: '100.00', referencia: '987654' })).toEqual({ resultado: 'ERROR', errores: [expect.stringMatching(/ya está registrada como pago de otro comprobante/)] });
  });

  it('5 pagos de S/ 100 al mismo tiempo sobre un saldo de S/ 300: solo pasan 3', async () => {
    const id = await emitir();
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => pagar(id, { monto: '100.00', referencia: `C-${i}` })));
    expect(rs.filter((r) => r.resultado === 'REGISTRADO')).toHaveLength(3);
    expect((await estadoCobro(db, id)).saldo.toFixed(2)).toBe('0.00');
  });

  it('anular un pago: vuelve el saldo; el pago no se borra ni se edita', async () => {
    const id = await emitir();
    const p = await pagar(id, { monto: '300.00', referencia: 'X1' });
    if (p.resultado === 'ERROR') throw new Error();
    const cobro = await anularPago(db, f.empresaId, p.pagoId, 'Se registró en el comprobante equivocado');
    expect(cobro).toMatchObject({ estadoPago: 'PENDIENTE' });
    await expect(anularPago(db, f.empresaId, p.pagoId, 'otra vez')).rejects.toThrow(/ya estaba anulado/);
    await expect(db.query(`DELETE FROM pagos WHERE id = $1`, [p.pagoId])).rejects.toThrow(/No se permite borrar/);
    await expect(db.query(`UPDATE pagos SET monto = 1 WHERE id = $1`, [p.pagoId])).rejects.toThrow(/no se modifica/);
    // La misma referencia se puede volver a usar después de anular el pago equivocado.
    expect((await pagar(id, { monto: '300.00', referencia: 'X1' })).resultado).toBe('REGISTRADO');
  });

  it('una nota de crédito reduce el saldo; si SUNAT la rechaza, el saldo vuelve', async () => {
    const boleta = await emitir();
    await procesarCola(db, s); // boleta aceptada
    const nc = await emitir({
      ...solicitudBoleta({ fechaEmision: hoy, items: [item('100.00')] }),
      tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01',
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo: '07', motivoDescripcion: 'Devolución' },
    });
    expect((await estadoCobro(db, boleta)).saldo.toFixed(2)).toBe('200.00');
    expect((await pagar(nc, { monto: '1.00' })).resultado).toBe('ERROR'); // una NC no se cobra
    sunat.colaBill.push({ modo: 'fault', codigo: '2800', mensaje: 'rechazo' });
    await procesarCola(db, s); // NC rechazada
    expect((await estadoCobro(db, boleta)).saldo.toFixed(2)).toBe('300.00');
  });

  it('cuotas: los pagos cubren las cuotas en orden y se avisa de vencimientos', async () => {
    // Fechas relativas a hoy: el facturador no emite con una fecha más antigua que el plazo de SUNAT.
    const hoyLima = ahoraLima().fecha;
    const vence2 = sumarDias(hoyLima, 60);
    const id = await emitir(solicitudFactura({
      fechaEmision: hoyLima, items: [item('1000.00')],
      formaPago: { tipo: 'CREDITO', cuotas: [{ monto: '600.00', fechaVencimiento: sumarDias(hoyLima, 30) }, { monto: '400.00', fechaVencimiento: vence2 }] },
    }));
    await pagar(id, { monto: '700.00', fecha: hoyLima });
    const q = await db.query(`SELECT numero_cuota, monto_pagado, pagada FROM comprobante_cuotas WHERE comprobante_id = $1 ORDER BY numero_cuota`, [id]);
    expect(q.rows).toEqual([{ numero_cuota: 1, monto_pagado: '600.00', pagada: true }, { numero_cuota: 2, monto_pagado: '100.00', pagada: false }]);

    expect(await revisarVencimientos(db, sumarDias(vence2, -2))).toBe(1); // cuota 2 vence en 2 días
    expect(await revisarVencimientos(db, sumarDias(vence2, 1))).toBe(1); // ya venció
    const a = await db.query(`SELECT tipo, severidad, mensaje FROM alertas WHERE empresa_id = $1 ORDER BY id`, [f.empresaId]);
    expect(a.rows.map((x) => [x.tipo, x.severidad])).toEqual([['CUOTA_POR_VENCER', 'AMARILLO'], ['CUOTA_VENCIDA', 'ROJO']]);
    expect(a.rows[1].mensaje).toMatch(/cuota 2 de F001-00000001 .* faltan S\/ 300\.00/);
    await revisarVencimientos(db, sumarDias(vence2, 2));
    expect((await db.query(`SELECT count(*)::int AS n FROM alertas WHERE empresa_id = $1`, [f.empresaId])).rows[0].n).toBe(2); // sin duplicar
  });

  it('resumen del día: ventas, cobros por medio y por cobrar', async () => {
    const a = await emitir();
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('50.00')] }));
    await pagar(a, { monto: '200.00', referencia: 'Y1' });
    await pagar(a, { monto: '100.00', medio: 'EFECTIVO' });
    const r = await resumenDelDia(db, f.empresaId, hoy);
    expect(r.ventas).toEqual({ cantidad: 2, total: '350.00', porTipo: { BOLETA: { cantidad: 2, total: '350.00' } } });
    expect(r.cobros).toEqual({ total: '300.00', porMedio: { EFECTIVO: '100.00', YAPE: '200.00' } });
    expect(r.porCobrar).toEqual({ comprobantes: 1, saldo: '50.00', cuotasVencidas: 0 });
    expect(r.sunat.pendientes).toBe(2);
  });

  describe('API', () => {
    let app: ReturnType<typeof crearApp>;
    let llave: string;
    beforeEach(async () => {
      app = crearApp({ db, servicios: s, limitePorMinuto: 1000 });
      llave = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda })).llave;
    });
    const pedir = (ruta: string, cuerpo?: unknown, k = llave) =>
      app.request(ruta, { method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }, ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}) });

    const pedidoYape = (pedido: string) => ({
      pedido, tipo: 'BOLETA', items: [{ descripcion: 'Tarima', cantidad: 1, precio: '350.00' }],
      pago: { medio: 'YAPE', referencia: `YP-${pedido}` },
    });

    it('emitir con el pago Yape confirmado: queda PAGADO en una sola llamada, y repetir no duplica el pago', async () => {
      const r = (await (await pedir('/v1/comprobantes', pedidoYape('ED-77'))).json()) as Record<string, unknown>;
      expect(r).toMatchObject({ estadoPago: 'PAGADO', saldo: '0.00', estado: 'ACEPTADO' });
      expect(r.pagos).toEqual([expect.objectContaining({ monto: '350.00', medio: 'YAPE', referencia: 'YP-ED-77', anulado: false })]);
      const otra = (await (await pedir('/v1/comprobantes', pedidoYape('ED-77'))).json()) as { repetido: boolean; pagos: unknown[] };
      expect(otra.repetido).toBe(true);
      expect(otra.pagos).toHaveLength(1);
    });

    it('registrar un pago por la API y consultar el resumen del día', async () => {
      const { id } = (await (await pedir('/v1/comprobantes', { pedido: 'ED-78', tipo: 'BOLETA', items: [{ descripcion: 'X', precio: '100.00' }] })).json()) as { id: string };
      const pago = await pedir(`/v1/comprobantes/${id}/pagos`, { monto: '40.00', medio: 'plin', referencia: 'PL-1' });
      expect(pago.status).toBe(201);
      expect(await pago.json()).toMatchObject({ estadoPago: 'PARCIAL', saldo: '60.00', pagado: '40.00', repetido: false });
      expect((await pedir(`/v1/comprobantes/${id}/pagos`, { monto: 40, medio: 'PLIN' })).status).toBe(422);
      const resumen = (await (await pedir('/v1/reportes/resumen-dia')).json()) as { cobros: { porMedio: Record<string, string> } };
      expect(resumen.cobros.porMedio).toEqual({ PLIN: '40.00' });
      expect((await pedir('/v1/reportes/resumen-dia?fecha=ayer')).status).toBe(400);
    });

    it('sin el permiso "cobrar" no se registran pagos (ni junto con la emisión)', async () => {
      const solo = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda, permisos: ['emitir', 'consultar'] })).llave;
      expect((await pedir('/v1/comprobantes', pedidoYape('ED-79'), solo)).status).toBe(403);
      expect((await pedir('/v1/reportes/resumen-dia', undefined, solo)).status).toBe(200);
    });
  });
});
