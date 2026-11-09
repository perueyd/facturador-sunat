/**
 * Nota de débito desde el panel y desde la API: cobrar algo más (flete, intereses, penalidad)
 * sobre una factura ya aceptada o una boleta. Pedido del dueño (09/11/2026) al comparar con
 * otro facturador. Catálogo 10 del Anexo 8 (R.S. 245-2017/SUNAT).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { crearLlaveApi } from '../../src/api/llaves.js';
import type { Db } from '../../src/db/conexion.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { RUC_CLIENTE } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('nota de débito (panel y API)', () => {
  let db: Db;
  let f: Fixture;
  let app: ReturnType<typeof crearApp>;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const formulario = () => `PANEL-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-debito-')));
    app = crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } });
    panel = panelDePrueba(app, db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('el dueño cobra un flete sobre una factura aceptada; un doble clic no emite dos', async () => {
    const dueno = await panel.entrar(f.empresaId, 'DUENO');
    const vendedor = await panel.entrar(f.empresaId, 'VENDEDOR');
    const factura = await (await panel.pedir('/panel/api/comprobantes', { cookie: dueno, cuerpo: {
      pedido: formulario(), canal: 'WhatsApp', tipo: 'FACTURA',
      cliente: { tipoDocumento: 'RUC', numero: RUC_CLIENTE, nombre: 'CLIENTE EMPRESA S.A.C.' },
      items: [{ descripcion: 'Tarima 2 plazas', cantidad: 1, precio: '350.00' }],
    } })).json();
    const cobrar = (cookie: string, pedido: string, extra: Record<string, unknown> = {}) => panel.pedir(`/panel/api/comprobantes/${factura.id}/nota-debito`, {
      cookie, cuerpo: { pedido, motivo: '02', concepto: 'Flete a Arequipa', sustento: 'Flete acordado después de la venta', monto: '59.00', ...extra },
    });
    expect((await cobrar(vendedor, formulario())).status).toBe(403);
    const antes = await cobrar(dueno, formulario());
    expect(antes.status).toBe(422); // SUNAT aún no aceptó la factura
    expect((await antes.json()).error.detalles.join(' ')).toMatch(/aún no fue aceptada/);

    await db.query(`UPDATE comprobantes SET estado = 'ACEPTADO' WHERE id = $1`, [factura.id]);
    const pedido = formulario();
    const r = await cobrar(dueno, pedido);
    expect(r.status).toBe(201);
    const nd = await r.json();
    expect(nd).toMatchObject({ numero: 'FD01-00000001', tipo: '08', total: '59.00', estadoPago: 'PENDIENTE' });
    expect((await (await cobrar(dueno, pedido)).json())).toMatchObject({ id: nd.id, repetido: true });
    // Queda en la lista de comprobantes (el PDF se prueba en tests/pdf.test.ts: aquí no hay certificado).
    const { comprobantes } = await (await panel.pedir('/panel/api/comprobantes', { cookie: dueno })).json();
    expect(comprobantes[0]).toMatchObject({ id: nd.id, tipo: '08', numero: 'FD01-00000001' });
    // Motivo fuera del catálogo 10: explicado.
    const mal = await cobrar(dueno, formulario(), { motivo: '07' });
    expect((await mal.json()).error.detalles.join(' ')).toMatch(/catálogo 10/);
  });

  it('desde la API: tipo NOTA_DEBITO con la serie por defecto BD01 para una boleta', async () => {
    const { llave } = await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda });
    const v1 = (cuerpo: unknown) => app.request('http://localhost/v1/comprobantes', {
      method: 'POST', headers: { Authorization: `Bearer ${llave}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
    });
    const boleta = await (await v1({ pedido: 'ED-ND-1', tipo: 'BOLETA', items: [{ descripcion: 'Almohada', cantidad: 1, precio: '59.90' }] })).json();
    const r = await v1({
      pedido: 'ED-ND-1-INTERES', tipo: 'NOTA_DEBITO', items: [{ descripcion: 'Interés por mora', cantidad: 1, precio: '3.00', unidad: 'ZZ' }],
      notaDebito: { tipo: 'BOLETA', serie: boleta.numero.slice(0, 4), numero: Number(boleta.numero.slice(5)), motivo: '01', descripcion: 'Pagó 20 días tarde' },
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ numero: 'BD01-00000001', tipo: '08' });
    const sinNota = await v1({ pedido: 'ED-ND-2', tipo: 'NOTA_DEBITO', items: [{ descripcion: 'X', cantidad: 1, precio: '1.00' }] });
    expect((await sinNota.json()).error.detalles.join(' ')).toMatch(/notaDebito: indica/);
  });

  it('otra empresa no puede cargarle nada a un comprobante ajeno', async () => {
    const otra = await crearEmpresa(db, `2060000003${digitoVerificadorRuc('2060000003')}`);
    const duenoOtra = await panel.entrar(otra.empresaId, 'DUENO');
    const ajeno = (await db.query(`SELECT id FROM comprobantes WHERE empresa_id = $1 AND tipo_comprobante = '01' LIMIT 1`, [f.empresaId])).rows[0].id;
    const r = await panel.pedir(`/panel/api/comprobantes/${ajeno}/nota-debito`, { cookie: duenoOtra, cuerpo: {
      pedido: formulario(), motivo: '02', concepto: 'X', sustento: 'X', monto: '1.00',
    } });
    expect(r.status).toBe(404);
  });
});
