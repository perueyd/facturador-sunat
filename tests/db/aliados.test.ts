/**
 * Aliados: venden el facturador y ganan comisión sobre lo que pagan sus clientes.
 * Lo delicado: que el aliado vea SOLO sus clientes y nunca sus comprobantes, que no pueda
 * volverse dueño de un negocio que ya funciona, que la comisión sea la del momento del pago
 * (cambiar el % no toca lo ya ganado) y que no se le pague más de lo ganado.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/conexion.js';
import { asignarEmpresa, crearUsuario } from '../../src/panel/usuarios.js';
import { registrarPago } from '../../src/plataforma/suscripciones.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { URL_PRUEBAS, activarSegundoPaso, crearEmpresa, prepararBase } from './base-prueba.js';

const CONTRASENA = 'clave del aliado 2026';

describe.skipIf(!URL_PRUEBAS)('aliados del facturador', () => {
  let db: Db;
  let app: ReturnType<typeof crearApp>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  let n = 0;
  const ruc = () => { const base = `20${String(60_000_000 + ++n).padStart(8, '0')}`; return base + digitoVerificadorRuc(base); };

  async function persona(empresaId: string, rol: 'DUENO' | 'CONTADOR', plataforma = false) {
    const email = `aliado${++n}@prueba.pe`;
    const u = await crearUsuario(db, { email, nombre: `Persona ${n}`, contrasena: CONTRASENA, llaveMaestra });
    await asignarEmpresa(db, u.usuarioId, empresaId, rol);
    await activarSegundoPaso(db, u.usuarioId, u.secreto, llaveMaestra);
    if (plataforma) await db.query(`UPDATE usuarios SET admin_plataforma = true WHERE id = $1`, [u.usuarioId]);
    const r = await app.request('http://localhost/panel/api/entrar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
      body: JSON.stringify({ email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, pasoActual()) }),
    });
    expect(r.status).toBe(200);
    return { usuarioId: u.usuarioId, email, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  }
  const panel = (ruta: string, cookie: string, cuerpo?: unknown) => app.request(`http://localhost/panel/api${ruta}`, {
    method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Panel': '1', Cookie: cookie },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const datosEmpresa = (extra: Record<string, unknown> = {}) => ({
    ruc: ruc(), razonSocial: `CLIENTE ${n} S.A.C.`, direccion: 'AV. UNO 1', distrito: 'LIMA', provincia: 'LIMA', departamento: 'LIMA',
    ubigeo: '150101', regimen: 'MYPE_TRIBUTARIO', regimenDesde: '2026-01-01', ...extra,
  });

  let admin: Awaited<ReturnType<typeof persona>>;
  let contador: Awaited<ReturnType<typeof persona>>;

  beforeAll(async () => {
    db = await prepararBase();
    app = crearApp({ db, enviarAlEmitir: false, servicios: {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-aliados-'))), llaveMaestra, algoritmo: 'SHA256', entorno: {},
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales }),
    } });
    const propia = await crearEmpresa(db, ruc());
    admin = await persona(propia.empresaId, 'DUENO', true);
    // El contador del dueño, que además venderá el facturador.
    contador = await persona(propia.empresaId, 'CONTADOR');
  });
  afterAll(async () => {
    await db?.end();
  });

  it('solo el administrador nombra aliados; antes de serlo, no da de alta empresas', async () => {
    expect((await panel('/empresas', contador.cookie, datosEmpresa())).status).toBe(403);
    expect((await panel('/aliado', contador.cookie)).status).toBe(403);
    expect((await panel('/plataforma/aliados', contador.cookie, { email: contador.email, comision: '20' })).status).toBe(403);
    expect((await panel('/plataforma/aliados', admin.cookie, { email: contador.email, comision: '150' })).status).toBe(422);
    expect((await panel('/plataforma/aliados', admin.cookie, { email: 'nadie@prueba.pe', comision: '20' })).status).toBe(422);
    expect((await panel('/plataforma/aliados', admin.cookie, { email: contador.email, comision: '20' })).status).toBe(200);
    expect((await (await panel('/yo', contador.cookie)).json()).aliado).toEqual({ comision: '20.00' });
  });

  it('el aliado da de alta a su cliente sin volverse su dueño, e invita al dueño una sola vez', async () => {
    const r = await panel('/empresas', contador.cookie, datosEmpresa({ propia: true, plan: 'NEGOCIO' }));
    expect(r.status).toBe(201);
    const { empresaId } = (await r.json()) as { empresaId: string };
    // Queda a su nombre y en prueba (aunque pidiera "propia"), pero él NO es usuario de esa empresa.
    expect((await db.query(`SELECT aliado_id, estado, plan_codigo FROM suscripciones WHERE empresa_id = $1`, [empresaId])).rows[0])
      .toEqual({ aliado_id: contador.usuarioId, estado: 'PRUEBA', plan_codigo: 'NEGOCIO' });
    expect((await db.query(`SELECT 1 FROM usuario_empresa WHERE empresa_id = $1 AND usuario_id = $2`, [empresaId, contador.usuarioId])).rowCount).toBe(0);

    // Ve a su cliente en "Mis clientes"; no ve los clientes de otros ni la empresa propia.
    const otro = await (await panel('/empresas', admin.cookie, datosEmpresa())).json() as { empresaId: string };
    const mis = await (await panel('/aliado', contador.cookie)).json() as { clientes: { empresaId: string }[] };
    expect(mis.clientes.map((x) => x.empresaId)).toEqual([empresaId]);
    // No puede invitar en la empresa de otro, ni invitarse a sí mismo.
    expect((await panel(`/aliado/${otro.empresaId}/invitar`, contador.cookie, { email: 'x@prueba.pe', nombre: 'X' })).status).toBe(404);
    expect((await panel(`/aliado/${empresaId}/invitar`, contador.cookie, { email: contador.email, nombre: 'Yo' })).status).toBe(422);
    const inv = await panel(`/aliado/${empresaId}/invitar`, contador.cookie, { email: 'duena@cliente.pe', nombre: 'Dueña' });
    expect(inv.status).toBe(201);
    expect(await inv.json()).toMatchObject({ existente: false, enlace: expect.stringContaining('/panel') });

    // Cuando el negocio ya tiene un dueño activo, el aliado ya no invita a nadie como dueño.
    const duena = await persona(empresaId, 'DUENO');
    expect(duena.usuarioId).toBeTruthy();
    expect((await panel(`/aliado/${empresaId}/invitar`, contador.cookie, { email: 'otro@prueba.pe', nombre: 'Otro' })).status).toBe(409);
  });

  it('comisión del momento del pago, pagos al aliado sin pasarse, y al desactivarlo ya no gana', async () => {
    const { empresaId } = await (await panel('/empresas', contador.cookie, datosEmpresa({ plan: 'EMPRENDEDOR' }))).json() as { empresaId: string };
    // Paga 39.00 al 20 % → 7.80. Luego el % sube a 25: el pago anterior no cambia, el nuevo sí.
    expect(await registrarPago(db, { empresaId, periodo: 'MENSUAL', medio: 'Yape', monto: '39.00', usuarioId: admin.usuarioId })).toMatchObject({ comisionAliado: '7.80' });
    expect((await panel('/plataforma/aliados', admin.cookie, { email: contador.email, comision: '25' })).status).toBe(200);
    expect(await registrarPago(db, { empresaId, periodo: 'MENSUAL', medio: 'Yape', monto: '39.99', usuarioId: admin.usuarioId })).toMatchObject({ comisionAliado: '10.00' });

    let c = (await (await panel('/aliado', contador.cookie)).json()).comisiones;
    expect(c).toMatchObject({ comision: '25.00', ganado: '17.80', ganadoMes: '17.80', pagado: '0.00', porPagar: '17.80' });

    // Pagarle: no más de lo que se le debe; el pago no se borra.
    expect((await panel(`/plataforma/aliados/${contador.usuarioId}/pago`, admin.cookie, { monto: '20.00', medio: 'Yape' })).status).toBe(422);
    expect(await (await panel(`/plataforma/aliados/${contador.usuarioId}/pago`, admin.cookie, { monto: '10.00', medio: 'Yape' })).json()).toMatchObject({ porPagar: '7.80' });
    await expect(db.query(`DELETE FROM pagos_aliado`)).rejects.toThrow(/solo inserción/);
    c = (await (await panel('/aliado', contador.cookie)).json()).comisiones;
    expect(c).toMatchObject({ pagado: '10.00', porPagar: '7.80', pagosRecibidos: [expect.objectContaining({ monto: '10.00', medio: 'Yape' })] });

    // El administrador ve cuánto le debe a cada aliado y quién trajo a cada cliente.
    const p = await (await panel('/plataforma', admin.cookie)).json() as { aliados: { aliadoId: string; porPagar: string }[]; clientes: { empresaId: string; aliado: string | null }[] };
    expect(p.aliados.find((a) => a.aliadoId === contador.usuarioId)).toMatchObject({ porPagar: '7.80' });
    expect(p.clientes.find((x) => x.empresaId === empresaId)?.aliado).toMatch(/^Persona/);

    // Desactivado: ya no da de alta empresas ni gana por los pagos nuevos; lo ganado queda.
    expect((await panel(`/plataforma/aliados/${contador.usuarioId}/desactivar`, admin.cookie, { motivo: 'Fin del acuerdo' })).status).toBe(200);
    expect((await panel('/empresas', contador.cookie, datosEmpresa())).status).toBe(403);
    expect((await panel('/aliado', contador.cookie)).status).toBe(403);
    expect(await registrarPago(db, { empresaId, periodo: 'MENSUAL', medio: 'Yape', usuarioId: admin.usuarioId })).not.toHaveProperty('comisionAliado');
    expect((await db.query(`SELECT sum(comision_monto)::text AS s FROM pagos_suscripcion WHERE aliado_id = $1`, [contador.usuarioId])).rows[0].s).toBe('17.80');
    // Todo quedó en la auditoría.
    const acciones = (await db.query(`SELECT DISTINCT accion FROM auditoria WHERE accion LIKE '%ALIADO%'`)).rows.map((x) => x.accion).sort();
    expect(acciones).toEqual(['ALTA_POR_ALIADO', 'DESACTIVAR_ALIADO', 'NOMBRAR_ALIADO', 'PAGAR_ALIADO']);
  });

  it('el administrador asigna o quita el aliado de un cliente; una empresa propia no lleva aliado', async () => {
    await db.query(`UPDATE aliados SET activo = true WHERE usuario_id = $1`, [contador.usuarioId]);
    const { empresaId } = await (await panel('/empresas', admin.cookie, datosEmpresa())).json() as { empresaId: string };
    expect((await panel(`/plataforma/${empresaId}/aliado`, admin.cookie, { aliadoId: contador.usuarioId })).status).toBe(200);
    expect((await (await panel('/aliado', contador.cookie)).json()).clientes.map((x: { empresaId: string }) => x.empresaId)).toContain(empresaId);
    expect((await panel(`/plataforma/${empresaId}/aliado`, admin.cookie, { aliadoId: '' })).status).toBe(200);
    expect((await db.query(`SELECT aliado_id FROM suscripciones WHERE empresa_id = $1`, [empresaId])).rows[0].aliado_id).toBeNull();
    const propia = await (await panel('/empresas', admin.cookie, datosEmpresa({ propia: true }))).json() as { empresaId: string };
    expect((await panel(`/plataforma/${propia.empresaId}/aliado`, admin.cookie, { aliadoId: contador.usuarioId })).status).toBe(422);
  });
});
