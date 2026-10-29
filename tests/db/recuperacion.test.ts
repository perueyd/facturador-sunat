/**
 * Recuperar el acceso sin entrar a Render:
 *   - códigos de respaldo (celular perdido),
 *   - enlace por correo (contraseña olvidada; pide además el segundo paso),
 *   - llave de la tienda (el dueño perdió las dos cosas).
 * Es la puerta de atrás del panel: se prueba que cada camino sirva UNA vez y solo a quien toca.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { crearLlaveApi } from '../../src/api/llaves.js';
import type { Correo } from '../../src/avisos/avisos.js';
import type { Db } from '../../src/db/conexion.js';
import { asignarEmpresa, crearUsuario, type Rol } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { RUC_CLIENTE, RUC_EMPRESA } from '../ayudantes.js';
import { URL_PRUEBAS, activarSegundoPaso, crearEmpresa, prepararBase } from './base-prueba.js';

const CONTRASENA = 'clave del dueño 2026';

const desdeBase32 = (texto: string) => {
  let bits = '';
  for (const ch of texto) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
};

describe.skipIf(!URL_PRUEBAS)('recuperar el acceso', () => {
  let db: Db;
  let app: ReturnType<typeof crearApp>;
  let sinCorreo: ReturnType<typeof crearApp>;
  let llaveTienda: string;
  let llaveOtra: string;
  let empresaId: string;
  const correos: Correo[] = [];
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  let n = 0;

  beforeAll(async () => {
    db = await prepararBase();
    const f = await crearEmpresa(db, RUC_EMPRESA);
    const otra = await crearEmpresa(db, RUC_CLIENTE);
    empresaId = f.empresaId;
    llaveTienda = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda })).llave;
    llaveOtra = (await crearLlaveApi(db, { empresaId: otra.empresaId, canalId: otra.canalTienda })).llave;
    const servicios = {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-recuperacion-'))), llaveMaestra, algoritmo: 'SHA256' as const, entorno: {},
      crearCliente: (url: string, credenciales: { usuario: string; clave: string }) => new ClienteSunatSoap({ url, credenciales }),
    };
    app = crearApp({ db, fallosPorMinuto: 100, servicios, correo: async (c) => void correos.push(c) });
    sinCorreo = crearApp({ db, fallosPorMinuto: 100, servicios });
  });
  afterAll(async () => {
    await db?.end();
  });

  const pedir = (ruta: string, d: { cuerpo?: unknown; cookie?: string; a?: ReturnType<typeof crearApp> } = {}) =>
    (d.a ?? app).request(`http://localhost${ruta}`, {
      method: d.cuerpo ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Panel': '1', ...(d.cookie ? { Cookie: d.cookie } : {}) },
      ...(d.cuerpo ? { body: JSON.stringify(d.cuerpo) } : {}),
    });

  /** Usuario ya activado; devuelve también sus códigos de respaldo (los de la activación). */
  async function usuario(rol: Rol = 'DUENO') {
    const email = `u${++n}@prueba.pe`;
    const { usuarioId, secreto } = await crearUsuario(db, { email, nombre: 'Prueba', contrasena: CONTRASENA, llaveMaestra });
    await asignarEmpresa(db, usuarioId, empresaId, rol);
    await activarSegundoPaso(db, usuarioId, secreto, llaveMaestra);
    return { usuarioId, email, secreto };
  }
  const entrar = (email: string, codigo: string, contrasena = CONTRASENA) =>
    pedir('/panel/api/entrar', { cuerpo: { email, contrasena, codigo } });
  const galleta = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;

  it('códigos de respaldo: cada uno entra UNA vez; generar nuevos exige un código y anula los viejos', async () => {
    const u = await usuario();
    const p = pasoActual();
    const sesion = galleta(await entrar(u.email, codigoTotp(u.secreto, p)));
    expect((await (await pedir('/panel/api/yo', { cookie: sesion })).json()).codigosRespaldo).toBe(0);

    expect((await pedir('/panel/api/codigos-respaldo', { cookie: sesion, cuerpo: { codigo: '000000' } })).status).toBe(422);
    const r = await pedir('/panel/api/codigos-respaldo', { cookie: sesion, cuerpo: { codigo: codigoTotp(u.secreto, p + 1) } });
    expect(r.status).toBe(200);
    const viejos = (await r.json()).codigosRespaldo as string[];
    expect(viejos).toHaveLength(10);
    expect(new Set(viejos).size).toBe(10);
    expect(viejos[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    // En minúsculas y sin guion también sirve (se copia a mano de un papel).
    const conRespaldo = await entrar(u.email, viejos[0]!.toLowerCase().replace('-', ''));
    expect(conRespaldo.status).toBe(200);
    expect((await entrar(u.email, viejos[0]!)).status).toBe(401);
    // Contraseña equivocada + código de respaldo bueno: no entra, y el código NO se gasta.
    expect((await entrar(u.email, viejos[1]!, 'equivocada!!')).status).toBe(401);
    expect((await (await pedir('/panel/api/yo', { cookie: galleta(conRespaldo) })).json()).codigosRespaldo).toBe(9);

    const nuevos = (await (await pedir('/panel/api/codigos-respaldo', { cookie: sesion, cuerpo: { codigo: viejos[1] } })).json()).codigosRespaldo as string[];
    expect(nuevos).toHaveLength(10);
    expect((await entrar(u.email, viejos[2]!)).status).toBe(401);
    expect((await entrar(u.email, nuevos[0]!)).status).toBe(200);
  });

  it('enlace por correo: no revela qué correos existen, vale una vez y pide el segundo paso', async () => {
    const u = await usuario('VENDEDOR');
    expect(await (await pedir('/panel/api/recuperar')).json()).toEqual({ correo: true });
    expect(await (await pedir('/panel/api/recuperar', { a: sinCorreo })).json()).toEqual({ correo: false });
    expect((await pedir('/panel/api/recuperar/correo', { a: sinCorreo, cuerpo: { email: u.email } })).status).toBe(409);

    correos.length = 0;
    const nadie = await pedir('/panel/api/recuperar/correo', { cuerpo: { email: 'nadie@prueba.pe' } });
    expect([nadie.status, await nadie.json()]).toEqual([200, { ok: true }]);
    const si = await pedir('/panel/api/recuperar/correo', { cuerpo: { email: u.email.toUpperCase() } });
    expect([si.status, await si.json()]).toEqual([200, { ok: true }]);
    // Un segundo pedido enseguida no manda otro correo.
    await pedir('/panel/api/recuperar/correo', { cuerpo: { email: u.email } });
    await new Promise((r) => setTimeout(r, 20));
    expect(correos).toHaveLength(1);
    expect(correos[0]!.para).toEqual([u.email]);
    const token = /#recuperar=([\w-]+)/.exec(correos[0]!.texto)?.[1];
    expect(token).toBeTruthy();
    // En la base queda solo la huella: el token del correo no aparece.
    const guardado = (await db.query(`SELECT token_hash FROM recuperaciones_correo WHERE usuario_id = $1`, [u.usuarioId])).rows[0].token_hash as Buffer;
    expect(guardado.toString('utf8')).not.toContain(token);

    // Paso fijo: la app acepta el paso de al lado, no más (si el reloj avanza, no se corre).
    const p = pasoActual();
    const viejaSesion = galleta(await entrar(u.email, codigoTotp(u.secreto, p)));
    const cambiar = (cuerpo: Record<string, unknown>) => pedir('/panel/api/recuperar/correo/cambiar', { cuerpo: { token, contrasena: 'clave nueva 2026', ...cuerpo } });
    expect((await cambiar({ token: 'x'.repeat(43) })).status).toBe(422);
    expect((await cambiar({ codigo: '000000' })).status).toBe(422);
    expect((await cambiar({ codigo: codigoTotp(u.secreto, p) })).status).toBe(422); // ese ya se usó
    expect((await cambiar({ contrasena: 'corta' })).status).toBe(422);
    const ok = await cambiar({ codigo: codigoTotp(u.secreto, p + 1) });
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, email: u.email }]);
    expect((await cambiar({ codigo: '000000' })).status).toBe(422); // el enlace ya se usó

    await new Promise((r) => setTimeout(r, 20));
    expect(correos.at(-1)!.asunto).toMatch(/Se cambió el acceso/);
    expect((await pedir('/panel/api/yo', { cookie: viejaSesion })).status).toBe(401);
    // Se simula el minuto siguiente para tener un código sin usar.
    await db.query(`UPDATE usuarios SET totp_ultimo_paso = totp_ultimo_paso - 2 WHERE id = $1`, [u.usuarioId]);
    expect((await entrar(u.email, codigoTotp(u.secreto, p + 1), 'clave nueva 2026')).status).toBe(200);
  });

  it('enlace vencido: ya no sirve', async () => {
    const u = await usuario();
    correos.length = 0;
    await pedir('/panel/api/recuperar/correo', { cuerpo: { email: u.email } });
    await new Promise((r) => setTimeout(r, 20));
    const token = /#recuperar=([\w-]+)/.exec(correos[0]!.texto)?.[1];
    await db.query(`UPDATE recuperaciones_correo SET expira_en = now() - interval '1 second' WHERE usuario_id = $1`, [u.usuarioId]);
    const r = await pedir('/panel/api/recuperar/correo/cambiar', { cuerpo: { token, contrasena: 'clave nueva 2026', codigo: codigoTotp(u.secreto, pasoActual() + 1) } });
    expect(r.status).toBe(422);
    expect((await r.json()).error.mensaje).toMatch(/venció/);
  });

  it('con la llave de la tienda: solo el DUEÑO de esa empresa, y entrega códigos de respaldo al activar', async () => {
    const vendedor = await usuario('VENDEDOR');
    const dueno = await usuario('DUENO');
    const datos = (email: string, clave: string) => ({ clave, email, contrasena: 'clave rescatada 2026' });
    expect((await pedir('/panel/api/recuperar', { cuerpo: datos(vendedor.email, llaveTienda) })).status).toBe(401);
    expect((await pedir('/panel/api/recuperar', { cuerpo: datos(dueno.email, llaveOtra) })).status).toBe(401);
    expect((await pedir('/panel/api/recuperar', { cuerpo: datos('nadie@prueba.pe', llaveTienda) })).status).toBe(401);

    correos.length = 0;
    const r = await pedir('/panel/api/recuperar', { cuerpo: datos(dueno.email, ` ${llaveTienda} `) });
    expect(r.status).toBe(200);
    const secreto = desdeBase32((await r.json()).clave);
    await new Promise((res) => setTimeout(res, 20));
    expect(correos.map((c) => c.asunto)).toEqual(['Se cambió el acceso a tu facturador']);

    const activar = await pedir('/panel/api/recuperar/activar', { cuerpo: { clave: llaveTienda, email: dueno.email, codigo: codigoTotp(secreto, pasoActual()) } });
    expect(activar.status).toBe(200);
    const { codigosRespaldo } = await activar.json();
    expect(codigosRespaldo).toHaveLength(10);
    expect((await entrar(dueno.email, codigosRespaldo[0], 'clave rescatada 2026')).status).toBe(200);
  });
});
