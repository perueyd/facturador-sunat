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

  // Pedido del dueño (09/11/2026): conectar la página web de un cliente sin usar la PC.
  it('el dueño conecta una página: la llave sale una vez, funciona y se puede desconectar', async () => {
    const dueno = await panel.entrar(f.empresaId, 'DUENO');
    const admin = await panel.entrar(f.empresaId, 'ADMIN');
    const conectar = (nombre: string, cookie = dueno) => panel.pedir('/panel/api/llaves', { cookie, cuerpo: { nombre } });
    expect((await conectar('Tienda de María', admin)).status).toBe(403);

    const r = await conectar('  Tienda   de María ');
    expect(r.status).toBe(201);
    const nueva = await r.json();
    expect(nueva).toMatchObject({ canal: 'Tienda de María', llave: expect.stringMatching(/^fk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/), direccion: expect.stringMatching(/\/v1\/comprobantes$/) });
    const usar = (llave: string) => app.request('http://localhost/v1/comprobantes?pedido=NO-EXISTE', { headers: { Authorization: `Bearer ${llave}` } });
    expect((await usar(nueva.llave)).status).toBe(404); // la llave entra (el pedido no existe)

    // Solo queda su huella: la lista nunca vuelve a mostrar el secreto.
    const { llaves } = await (await panel.pedir('/panel/api/llaves', { cookie: dueno })).json();
    expect(llaves[0]).toMatchObject({ canal: 'Tienda de María', activa: true, prefijo: nueva.prefijo });
    expect(JSON.stringify(llaves)).not.toContain(nueva.llave.slice(-20));

    // Una sola llave activa por página; los canales del panel no se convierten en página.
    expect(await (await conectar('tienda de maría')).json()).toMatchObject({ error: { mensaje: expect.stringMatching(/ya está conectada/) } });
    expect((await conectar('WhatsApp')).status).toBe(422);
    expect((await conectar('x')).status).toBe(422);

    // Desconectar y volver a conectar: llave nueva, la vieja ya no sirve.
    expect((await panel.pedir(`/panel/api/llaves/${nueva.prefijo}/desactivar`, { cookie: dueno, cuerpo: {} })).status).toBe(200);
    const otra = await (await conectar('Tienda de María')).json();
    expect(otra.prefijo).not.toBe(nueva.prefijo);
    expect((await usar(nueva.llave)).status).toBe(401);
    expect((await usar(otra.llave)).status).toBe(404);
    expect((await db.query(`SELECT count(*)::int AS n FROM canales WHERE empresa_id = $1 AND nombre = 'Tienda de María'`, [f.empresaId])).rows[0].n).toBe(1);
  });

  it('dos clics a la vez no dejan dos llaves activas para la misma página', async () => {
    const dueno = await panel.entrar(f.empresaId, 'DUENO');
    const r = await Promise.all([1, 2].map(() => panel.pedir('/panel/api/llaves', { cookie: dueno, cuerpo: { nombre: 'Página doble' } })));
    expect(r.map((x) => x.status).sort()).toEqual([201, 422]);
  });

  it('hay un tope de páginas conectadas a la vez', async () => {
    const dueno = await panel.entrar(f.empresaId, 'DUENO');
    const activas = (await db.query(`SELECT count(*)::int AS n FROM api_llaves WHERE empresa_id = $1 AND revocada_en IS NULL`, [f.empresaId])).rows[0].n;
    for (let i = activas; i < 10; i++) expect((await panel.pedir('/panel/api/llaves', { cookie: dueno, cuerpo: { nombre: `Página ${i}` } })).status).toBe(201);
    const r = await panel.pedir('/panel/api/llaves', { cookie: dueno, cuerpo: { nombre: 'Una más' } });
    expect(r.status).toBe(422);
    expect((await r.json()).error.mensaje).toMatch(/Ya tienes 10 páginas conectadas/);
  });
});
