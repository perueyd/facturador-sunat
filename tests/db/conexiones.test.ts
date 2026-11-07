/**
 * Conexiones con otros sistemas: el dueño ve las llaves de API (ej. la de la tienda web) y las
 * desconecta desde el panel. Pedido del dueño: tienda y facturador independientes.
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
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('conexiones (llaves de API) desde el panel', () => {
  let db: Db;
  let f: Fixture;
  let app: ReturnType<typeof crearApp>;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-conexiones-')));
    app = crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } });
    panel = panelDePrueba(app, db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('solo el dueño las ve y desconecta; una llave desconectada ya no emite', async () => {
    const { llave, prefijo } = await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda });
    const consultar = () => app.request('http://localhost/v1/comprobantes', { headers: { Authorization: `Bearer ${llave}` } });
    expect((await consultar()).status).not.toBe(401); // la llave sirve (pide más datos, pero entra)

    const dueno = await panel.entrar(f.empresaId, 'DUENO');
    const admin = await panel.entrar(f.empresaId, 'ADMIN');
    expect((await panel.pedir('/panel/api/llaves', { cookie: admin })).status).toBe(403);
    const { llaves } = await (await panel.pedir('/panel/api/llaves', { cookie: dueno })).json();
    expect(llaves).toEqual([expect.objectContaining({ prefijo, canal: 'Tienda web', activa: true })]);
    expect(JSON.stringify(llaves)).not.toContain(llave.slice(-20)); // el secreto nunca sale

    expect((await panel.pedir(`/panel/api/llaves/${prefijo}/desactivar`, { cookie: admin, cuerpo: {} })).status).toBe(403);
    expect((await panel.pedir(`/panel/api/llaves/${prefijo}/desactivar`, { cookie: dueno, cuerpo: {} })).status).toBe(200);
    expect((await consultar()).status).toBe(401);
    expect((await panel.pedir(`/panel/api/llaves/${prefijo}/desactivar`, { cookie: dueno, cuerpo: {} })).status).toBe(404);
    const despues = await (await panel.pedir('/panel/api/llaves', { cookie: dueno })).json();
    expect(despues.llaves[0]).toMatchObject({ activa: false });
  });
});
