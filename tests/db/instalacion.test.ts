/**
 * Primera configuración del panel desde el celular: crea el PRIMER usuario sin la PC.
 * Es la puerta más delicada del panel, así que se prueba que se cierre para siempre en
 * cuanto existe un usuario, que exija la clave y que no se pueda adivinar sin fin.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { crearLlaveApi, revocarLlave } from '../../src/api/llaves.js';
import type { Db } from '../../src/db/conexion.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { RUC_CLIENTE, RUC_EMPRESA } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, liberarCodigos, prepararBase } from './base-prueba.js';

const CLAVE = 'clave-de-instalacion-larga-2026';
const CONTRASENA = 'clave del dueño 2026';
const RECUPERACION = 'clave-de-recuperacion-larga-2026';

const desdeBase32 = (texto: string) => {
  let bits = '';
  for (const ch of texto) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
};

describe.skipIf(!URL_PRUEBAS)('primera configuración del panel', () => {
  let db: Db;
  let app: ReturnType<typeof crearApp>;
  let sinClave: ReturnType<typeof crearApp>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    await crearEmpresa(db, RUC_EMPRESA);
    // Aquí no se emite nada: SUNAT nunca se llama.
    const servicios = {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-instalacion-'))), llaveMaestra, algoritmo: 'SHA256' as const, entorno: {},
      crearCliente: (url: string, credenciales: { usuario: string; clave: string }) => new ClienteSunatSoap({ url, credenciales }),
    };
    app = crearApp({ db, claveInstalacion: CLAVE, claveRecuperacion: RECUPERACION, fallosPorMinuto: 5, servicios });
    sinClave = crearApp({ db, servicios });
  });
  afterAll(async () => {
    await db?.end();
  });

  const pedir = (a: ReturnType<typeof crearApp>, ruta: string, cuerpo?: unknown, ip = '1.1.1.1') =>
    a.request(`http://localhost${ruta}`, {
      method: cuerpo ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Panel': '1', 'X-Forwarded-For': ip },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });
  const datos = { clave: CLAVE, ruc: RUC_EMPRESA, nombre: 'Dueño', email: 'Dueno@Prueba.pe', contrasena: CONTRASENA };

  it('sin CLAVE_INSTALACION en Render, existe pero esa clave no sirve', async () => {
    expect(await (await pedir(sinClave, '/panel/api/instalacion')).json()).toEqual({ disponible: true });
    expect((await pedir(sinClave, '/panel/api/instalacion', datos)).status).toBe(401);
  });

  it('clave equivocada: se rechaza y, tras varios intentos, se frena', async () => {
    expect(await (await pedir(app, '/panel/api/instalacion')).json()).toEqual({ disponible: true });
    for (let i = 0; i < 5; i++) expect((await pedir(app, '/panel/api/instalacion', { ...datos, clave: 'no' }, '9.9.9.9')).status).toBe(401);
    expect((await pedir(app, '/panel/api/instalacion', datos, '9.9.9.9')).status).toBe(429);
  });

  it('crea al dueño (administrador de la plataforma), lo activa con su código y entra; después la puerta se cierra', async () => {
    expect((await pedir(app, '/panel/api/instalacion', { ...datos, ruc: '20123456789' })).status).toBe(422);
    const r = await pedir(app, '/panel/api/instalacion', datos);
    expect(r.status).toBe(201);
    const d = await r.json();
    const secreto = desdeBase32(d.clave);

    // Una segunda creación (otra pestaña, otra persona) ya no puede.
    expect((await pedir(app, '/panel/api/instalacion', { ...datos, email: 'intruso@prueba.pe' })).status).toBe(409);
    expect((await pedir(app, '/panel/api/instalacion/activar', { clave: 'no', usuarioId: d.usuarioId, codigo: '000000' })).status).toBe(401);
    expect((await pedir(app, '/panel/api/instalacion/activar', { clave: CLAVE, usuarioId: d.usuarioId, codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(200);
    await liberarCodigos(db, d.usuarioId);
    // Ya activado: no se puede volver a "activar" (ni cambiarle el segundo paso por aquí).
    expect((await pedir(app, '/panel/api/instalacion/activar', { clave: CLAVE, usuarioId: d.usuarioId, codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(409);
    expect(await (await pedir(app, '/panel/api/instalacion')).json()).toEqual({ disponible: false });

    const entrar = await pedir(app, '/panel/api/entrar', { email: 'dueno@prueba.pe', contrasena: CONTRASENA, codigo: codigoTotp(secreto, pasoActual()) });
    expect(entrar.status).toBe(200);
    const cookie = (entrar.headers.get('set-cookie') ?? '').split(';')[0]!;
    const yo = await (await app.request('http://localhost/panel/api/yo', { headers: { Cookie: cookie } })).json();
    expect(yo).toMatchObject({ adminPlataforma: true, esDueno: true, empresa: { ruc: RUC_EMPRESA } });
  });

  it('recuperar el acceso: con la clave de Render, contraseña y segundo paso nuevos; las sesiones viejas caen', async () => {
    // Usa al dueño creado en la prueba anterior.
    const sesionVieja = await (async () => {
      const u = await db.query(`SELECT id FROM usuarios WHERE email = 'dueno@prueba.pe'`);
      expect(u.rows).toHaveLength(1);
      return u.rows[0].id as string;
    })();
    expect((await pedir(sinClave, '/panel/api/recuperar', { clave: RECUPERACION, email: 'dueno@prueba.pe', contrasena: 'otra clave nueva 2026' })).status).toBe(401);
    expect((await pedir(app, '/panel/api/recuperar', { clave: 'no', email: 'dueno@prueba.pe', contrasena: 'otra clave nueva 2026' }, '2.2.2.2')).status).toBe(401);
    expect((await pedir(app, '/panel/api/recuperar', { clave: RECUPERACION, email: 'nadie@prueba.pe', contrasena: 'otra clave nueva 2026' })).status).toBe(404);
    expect((await pedir(app, '/panel/api/recuperar', { clave: RECUPERACION, email: 'dueno@prueba.pe', contrasena: 'corta' })).status).toBe(422);
    // Un segundo paso vigente no se puede "activar" encima.
    expect((await pedir(app, '/panel/api/recuperar/activar', { clave: RECUPERACION, email: 'dueno@prueba.pe', codigo: '000000' })).status).toBe(409);

    const r = await pedir(app, '/panel/api/recuperar', { clave: RECUPERACION, email: 'DUENO@prueba.pe', contrasena: 'otra clave nueva 2026' });
    expect(r.status).toBe(200);
    const secreto = desdeBase32((await r.json()).clave);
    const sesiones = await db.query(`SELECT count(*)::int AS n FROM sesiones WHERE usuario_id = $1 AND revocada_en IS NULL`, [sesionVieja]);
    expect(sesiones.rows[0].n).toBe(0);
    // Sin activar el nuevo segundo paso, no entra ni con la contraseña nueva.
    expect((await pedir(app, '/panel/api/entrar', { email: 'dueno@prueba.pe', contrasena: 'otra clave nueva 2026', codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(401);
    expect((await pedir(app, '/panel/api/recuperar/activar', { clave: RECUPERACION, email: 'dueno@prueba.pe', codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(200);
    await liberarCodigos(db, sesionVieja);
    expect((await pedir(app, '/panel/api/entrar', { email: 'dueno@prueba.pe', contrasena: CONTRASENA, codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(401);
    expect((await pedir(app, '/panel/api/entrar', { email: 'dueno@prueba.pe', contrasena: 'otra clave nueva 2026', codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(200);
  });

  it('clave de Render demasiado corta: lo dice claramente en vez de "incorrecta"', async () => {
    const corta = crearApp({ db, claveRecuperacion: 'corta', servicios: { almacen: new AlmacenLocal(tmpdir()), llaveMaestra, algoritmo: 'SHA256', entorno: {},
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales }) } });
    const r = await pedir(corta, '/panel/api/recuperar', { clave: 'corta', email: 'dueno@prueba.pe', contrasena: 'otra clave nueva 2026' });
    expect(r.status).toBe(401);
    expect((await r.json()).error.mensaje).toMatch(/16 caracteres/);
  });
});

// El dueño sin acceso a Render: prueba que es él con la llave que la tienda tiene en Vercel.
describe.skipIf(!URL_PRUEBAS)('primera configuración con la llave de la tienda', () => {
  let db: Db;
  let app: ReturnType<typeof crearApp>;
  let llave: string;
  let ajena: string;
  let revocada: string;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    const f = await crearEmpresa(db, RUC_EMPRESA);
    const otra = await crearEmpresa(db, RUC_CLIENTE);
    llave = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda })).llave;
    ajena = (await crearLlaveApi(db, { empresaId: otra.empresaId, canalId: otra.canalTienda })).llave;
    const r = await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda });
    await revocarLlave(db, f.empresaId, r.prefijo);
    revocada = r.llave;
    app = crearApp({ db, fallosPorMinuto: 20, servicios: {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-instalacion-'))), llaveMaestra, algoritmo: 'SHA256', entorno: {},
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales }),
    } });
  });
  afterAll(async () => {
    await db?.end();
  });

  const pedir = (ruta: string, cuerpo: unknown) =>
    app.request(`http://localhost${ruta}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel': '1', 'X-Forwarded-For': '3.3.3.3' }, body: JSON.stringify(cuerpo),
    });
  const datos = () => ({ clave: llave, ruc: RUC_EMPRESA, nombre: 'Dueño', email: 'dueno@prueba.pe', contrasena: CONTRASENA });

  it('la llave de OTRA empresa, una revocada o una inventada no sirven', async () => {
    expect((await pedir('/panel/api/instalacion', { ...datos(), clave: ajena })).status).toBe(401);
    expect((await pedir('/panel/api/instalacion', { ...datos(), clave: revocada })).status).toBe(401);
    expect((await pedir('/panel/api/instalacion', { ...datos(), clave: 'fk_000000000000_' + 'a'.repeat(43) })).status).toBe(401);
    // Con la llave buena pero el RUC de la otra empresa, tampoco.
    expect((await pedir('/panel/api/instalacion', { ...datos(), ruc: RUC_CLIENTE })).status).toBe(401);
  });

  it('con la llave de la tienda (aunque traiga espacios) crea al dueño y lo activa', async () => {
    const r = await pedir('/panel/api/instalacion', { ...datos(), clave: ` ${llave} ` });
    expect(r.status).toBe(201);
    const d = await r.json();
    const secreto = desdeBase32(d.clave);
    expect((await pedir('/panel/api/instalacion/activar', { clave: ajena, usuarioId: d.usuarioId, codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(401);
    expect((await pedir('/panel/api/instalacion/activar', { clave: llave, usuarioId: d.usuarioId, codigo: codigoTotp(secreto, pasoActual()) })).status).toBe(200);
    expect((await pedir('/panel/api/instalacion', datos())).status).toBe(409);
  });
});
