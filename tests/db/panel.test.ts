/**
 * Panel web de punta a punta: entrar con contraseña + código, permisos por rol,
 * emitir, aislamiento entre empresas y protecciones (bloqueo, código reusado, CSRF).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/conexion.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { guardarProducto } from '../../src/inventario/productos.js';
import { activarTotp, asignarEmpresa, crearUsuario, type Rol } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

const CONTRASENA = 'clave del panel 2026';

describe.skipIf(!URL_PRUEBAS)('panel web', () => {
  let db: Db;
  let f: Fixture;
  let app: ReturnType<typeof crearApp>;
  const sunat = new SunatSimulado();
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  let n = 0;

  beforeAll(async () => {
    db = await prepararBase();
    await sunat.iniciar();
    app = crearApp({
      db,
      fallosPorMinuto: 1000,
      servicios: {
        almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-panel-'))),
        llaveMaestra, algoritmo: 'SHA256', entorno: { SUNAT_URL_BETA: sunat.url },
        ahora: () => new Date(Date.now() + 60_000),
        crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales, tiempoMaximoMs: 400 }),
      },
    });
  });
  afterAll(async () => {
    await sunat.detener();
    await db?.end();
  });

  const nuevaEmpresa = async () => {
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const e = await crearEmpresa(db, base + digitoVerificadorRuc(base));
    await guardarCertificado(db, { empresaId: e.empresaId, pfx: crearPfxPrueba(), clave: 'clave-de-prueba', llaveMaestra });
    return e;
  };
  beforeEach(async () => {
    sunat.reiniciar();
    f = await nuevaEmpresa();
  });

  /** Usuario con 2FA activo. El código de activación gasta el paso actual: para entrar se usa el siguiente. */
  async function usuario(rol: Rol = 'VENDEDOR', empresaId = f.empresaId) {
    const email = `u${++n}@prueba.pe`;
    const { usuarioId, secreto } = await crearUsuario(db, { email, nombre: `Usuario ${n}`, contrasena: CONTRASENA, llaveMaestra });
    await asignarEmpresa(db, usuarioId, empresaId, rol);
    expect(await activarTotp(db, usuarioId, codigoTotp(secreto, pasoActual() - 1), llaveMaestra)).toBe(true);
    return { email, secreto, usuarioId };
  }

  const pedir = (ruta: string, o: { cuerpo?: unknown; cookie?: string; sinCabecera?: boolean; origen?: string } = {}) =>
    app.request(`http://localhost${ruta}`, {
      method: o.cuerpo !== undefined ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(o.sinCabecera ? {} : { 'X-Panel': '1' }),
        ...(o.cookie ? { Cookie: o.cookie } : {}),
        ...(o.origen ? { Origin: o.origen } : {}),
      },
      ...(o.cuerpo !== undefined ? { body: JSON.stringify(o.cuerpo) } : {}),
    });

  async function entrar(u: { email: string; secreto: Buffer }, paso = pasoActual()): Promise<string> {
    const r = await pedir('/panel/api/entrar', { cuerpo: { email: u.email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, paso) } });
    expect(r.status).toBe(200);
    const galleta = r.headers.get('set-cookie') ?? '';
    expect(galleta).toMatch(/__Host-panel=.+; .*HttpOnly/i);
    expect(galleta).toMatch(/Secure/);
    expect(galleta).toMatch(/SameSite=Strict/i);
    return galleta.split(';')[0]!;
  }

  const boleta = (extra: Record<string, unknown> = {}) => ({
    pedido: `PANEL-${crypto.randomUUID()}`,
    canal: 'WhatsApp',
    tipo: 'BOLETA',
    cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: 'JUAN PÉREZ' },
    items: [{ descripcion: 'Cabecera Milán', cantidad: 1, precio: '220.00' }],
    ...extra,
  });

  it('la página se sirve con política de contenido estricta', async () => {
    const r = await pedir('/panel');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(await r.text()).toContain('/panel/app.js');
  });

  it('entrar y emitir: sale B001 por el canal elegido, con el usuario como autor', async () => {
    const u = await usuario('VENDEDOR');
    const cookie = await entrar(u);
    const yo = await (await pedir('/panel/api/yo', { cookie })).json();
    expect(yo).toMatchObject({ puedeEmitir: true, canales: ['Instagram', 'Presencial', 'WhatsApp'] });

    const r = await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta({ pago: { medio: 'EFECTIVO' } }) });
    expect(r.status).toBe(201);
    const c = await r.json();
    expect(c).toMatchObject({ numero: 'B001-00000001', total: '220.00', estadoPago: 'PAGADO' });
    const fila = await db.query(`SELECT emitido_por_usuario, ca.nombre FROM comprobantes co JOIN canales ca ON ca.id = co.canal_id WHERE co.id = $1`, [c.id]);
    expect(fila.rows[0]).toEqual({ emitido_por_usuario: u.usuarioId, nombre: 'WhatsApp' });

    const lista = await (await pedir('/panel/api/comprobantes', { cookie })).json();
    expect(lista.comprobantes[0]).toMatchObject({ numero: 'B001-00000001', canal: 'WhatsApp' });
    const pdf = await pedir(`/panel/api/comprobantes/${c.id}/pdf`, { cookie });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });

  it('pulsar dos veces "Emitir" (mismo número interno) no emite dos', async () => {
    const cookie = await entrar(await usuario());
    const cuerpo = boleta();
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo })).status).toBe(201);
    const segunda = await pedir('/panel/api/comprobantes', { cookie, cuerpo });
    expect(segunda.status).toBe(200);
    expect(await segunda.json()).toMatchObject({ numero: 'B001-00000001', repetido: true });
  });

  it('no emite como "Tienda web" ni sin número interno del formulario', async () => {
    const cookie = await entrar(await usuario());
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta({ canal: 'Tienda web' }) })).status).toBe(422);
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta({ pedido: 'ED-123' }) })).status).toBe(422);
  });

  it('SOLO_LECTURA y CONTADOR consultan pero no emiten', async () => {
    for (const rol of ['SOLO_LECTURA', 'CONTADOR'] as const) {
      const cookie = await entrar(await usuario(rol));
      expect((await (await pedir('/panel/api/yo', { cookie })).json()).puedeEmitir).toBe(false);
      expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta() })).status).toBe(403);
      expect((await pedir('/panel/api/comprobantes', { cookie })).status).toBe(200);
    }
  });

  it('nunca ve ni elige otra empresa', async () => {
    const otra = await nuevaEmpresa();
    const ajeno = await entrar(await usuario('DUENO', otra.empresaId));
    const ajenoId = (await (await pedir('/panel/api/comprobantes', { cookie: ajeno, cuerpo: boleta() })).json()).id as string;

    const cookie = await entrar(await usuario('DUENO'));
    expect((await pedir(`/panel/api/comprobantes/${ajenoId}`, { cookie })).status).toBe(404);
    expect((await pedir(`/panel/api/comprobantes/${ajenoId}/pdf`, { cookie })).status).toBe(404);
    expect((await pedir('/panel/api/empresa', { cookie, cuerpo: { empresaId: otra.empresaId } })).status).toBe(404);
    expect((await (await pedir('/panel/api/comprobantes', { cookie })).json()).comprobantes).toEqual([]);
  });

  it('con dos empresas asignadas, cambia entre ellas', async () => {
    const otra = await nuevaEmpresa();
    const u = await usuario('DUENO');
    await asignarEmpresa(db, u.usuarioId, otra.empresaId, 'ADMIN');
    const cookie = await entrar(u);
    expect((await (await pedir('/panel/api/yo', { cookie })).json()).empresas).toHaveLength(2);
    expect((await pedir('/panel/api/empresa', { cookie, cuerpo: { empresaId: otra.empresaId } })).status).toBe(200);
    expect((await (await pedir('/panel/api/yo', { cookie })).json()).empresa.id).toBe(otra.empresaId);
  });

  it('datos incorrectos: el mismo mensaje sin revelar qué falló; 5 fallos bloquean la cuenta', async () => {
    const u = await usuario();
    const mal = (cuerpo: Record<string, string>) => pedir('/panel/api/entrar', { cuerpo: { email: u.email, contrasena: CONTRASENA, codigo: '000000', ...cuerpo } });
    const a = await (await mal({ contrasena: 'equivocada!!' })).json();
    const b = await (await mal({ email: 'nadie@prueba.pe' })).json();
    expect(a.error.mensaje).toBe(b.error.mensaje);
    for (let i = 0; i < 4; i++) await mal({});
    // Ya bloqueado: ni con todo correcto entra.
    const r = await pedir('/panel/api/entrar', { cuerpo: { email: u.email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, pasoActual()) } });
    expect(r.status).toBe(401);
    expect((await r.json()).error.mensaje).toMatch(/bloqueada/);
  });

  it('un código ya usado no sirve para entrar otra vez', async () => {
    const u = await usuario();
    await entrar(u);
    const r = await pedir('/panel/api/entrar', { cuerpo: { email: u.email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, pasoActual()) } });
    expect(r.status).toBe(401);
  });

  it('sin el segundo paso activado no se entra', async () => {
    const { usuarioId, secreto } = await crearUsuario(db, { email: `sin2fa${++n}@prueba.pe`, nombre: 'X', contrasena: CONTRASENA, llaveMaestra });
    await asignarEmpresa(db, usuarioId, f.empresaId, 'DUENO');
    const r = await pedir('/panel/api/entrar', { cuerpo: { email: `sin2fa${n}@prueba.pe`, contrasena: CONTRASENA, codigo: codigoTotp(secreto, pasoActual()) } });
    expect(r.status).toBe(401);
  });

  it('órdenes desde otro sitio (CSRF) se rechazan', async () => {
    const cookie = await entrar(await usuario());
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta(), sinCabecera: true })).status).toBe(403);
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta(), origen: 'https://malicioso.example' })).status).toBe(403);
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta(), origen: 'http://localhost' })).status).toBe(201);
  });

  it('salir revoca la sesión; usuario desactivado pierde el acceso al instante', async () => {
    const u = await usuario();
    const cookie = await entrar(u);
    expect((await pedir('/panel/api/salir', { cookie, cuerpo: {} })).status).toBe(200);
    expect((await pedir('/panel/api/yo', { cookie })).status).toBe(401);

    const cookie2 = await entrar(u, pasoActual() + 1);
    await db.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [u.usuarioId]);
    expect((await pedir('/panel/api/yo', { cookie: cookie2 })).status).toBe(401);
  });

  it('en la base solo queda la huella del token, nunca el token', async () => {
    const cookie = await entrar(await usuario());
    const token = cookie.split('=')[1]!;
    const r = await db.query(`SELECT count(*)::int AS n FROM sesiones WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'`, [token]);
    expect(r.rows[0].n).toBe(0);
  });

  // ---------- Funciones agregadas al panel ----------

  /** Boleta emitida desde el panel y ya aceptada por SUNAT (simulado). */
  async function emitida(cookie: string, extra: Record<string, unknown> = {}) {
    const r = await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta(extra) });
    expect(r.status).toBe(201);
    return (await r.json()) as { id: string; numero: string; estado: string };
  }

  it('tablero: vencimiento, resumen y certificado según las funciones activas de la empresa', async () => {
    const cookie = await entrar(await usuario('DUENO'));
    await emitida(cookie);
    const t = await (await pedir('/panel/api/tablero', { cookie })).json();
    expect(t.vencimiento.vence ?? t.vencimiento.faltaCronograma).toBeTruthy();
    expect(t.resumen.estimado).toBe(true);
    expect(t.certificado.dias).toBeGreaterThan(0);

    await db.query(`UPDATE empresas SET modulos_desactivados = '{resumen,vencimientos}' WHERE id = $1`, [f.empresaId]);
    const t2 = await (await pedir('/panel/api/tablero', { cookie })).json();
    expect(t2.resumen).toBeUndefined();
    expect(t2.vencimiento).toBeUndefined();
    expect(t2.sunat).toBeDefined();
  });

  it('panel desactivado para una empresa: ni aparece (sigue por API)', async () => {
    const cookie = await entrar(await usuario('DUENO'));
    await db.query(`UPDATE empresas SET modulos_desactivados = '{panel}' WHERE id = $1`, [f.empresaId]);
    const yo = await (await pedir('/panel/api/yo', { cookie })).json();
    expect(yo.empresas).toEqual([]);
    expect((await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta() })).status).toBe(403);
  });

  it('exportar: CSV para Excel, sin fórmulas peligrosas; se puede desactivar', async () => {
    const cookie = await entrar(await usuario('CONTADOR'));
    const vendedor = await entrar(await usuario('VENDEDOR'));
    await emitida(vendedor, { cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: '=HYPERLINK("x")' } });
    const mes = new Date().toISOString().slice(0, 7);
    const r = await pedir(`/panel/api/exportar?mes=${mes}`, { cookie });
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM: Excel reconoce las tildes
    const csv = bytes.subarray(3).toString('utf8');
    expect(csv.startsWith('Fecha;Tipo;Número')).toBe(true);
    expect(csv).toContain('B001-00000001');
    expect(csv).toContain(`'=HYPERLINK`);
    expect((await pedir('/panel/api/exportar?mes=2026-13', { cookie })).status).toBe(400);
    await db.query(`UPDATE empresas SET modulos_desactivados = '{exportar}' WHERE id = $1`, [f.empresaId]);
    expect((await pedir(`/panel/api/exportar?mes=${mes}`, { cookie })).status).toBe(403);
  });

  it('productos guardados y cliente conocido por su documento', async () => {
    await guardarProducto(db, f.empresaId, { sku: 'CAB-001', nombre: 'Cabecera Milán', precio: '220.00' });
    const cookie = await entrar(await usuario());
    expect((await (await pedir('/panel/api/productos', { cookie })).json()).productos).toEqual([{ sku: 'CAB-001', nombre: 'Cabecera Milán', precio: '220.00' }]);
    expect((await pedir('/panel/api/clientes?doc=12345678', { cookie })).status).toBe(404);
    await emitida(cookie);
    expect(await (await pedir('/panel/api/clientes?doc=12345678', { cookie })).json()).toEqual({ nombre: 'JUAN PÉREZ' });
    expect((await pedir('/panel/api/clientes?doc=x%27', { cookie })).status).toBe(400);
  });

  it('devolución total: nota de crédito BC01 solo para dueño/administrador; no se repite', async () => {
    const vendedor = await entrar(await usuario('VENDEDOR'));
    const b = await emitida(vendedor);
    expect(b.estado).toBe('ACEPTADO');
    expect((await pedir(`/panel/api/comprobantes/${b.id}/devolucion`, { cookie: vendedor, cuerpo: { motivo: 'x' } })).status).toBe(403);
    expect((await (await pedir('/panel/api/yo', { cookie: vendedor })).json()).puedeCorregir).toBe(false);

    const dueno = await entrar(await usuario('DUENO'));
    const nc = await pedir(`/panel/api/comprobantes/${b.id}/devolucion`, { cookie: dueno, cuerpo: { motivo: 'Cliente devolvió la cabecera' } });
    expect(nc.status).toBe(201);
    expect(await nc.json()).toMatchObject({ numero: 'BC01-00000001', total: '220.00', tipo: '07' });
    expect((await pedir(`/panel/api/comprobantes/${b.id}/devolucion`, { cookie: dueno, cuerpo: { motivo: 'otra vez' } })).status).toBe(409);
  });

  it('anular desde el panel: pasa por resumen diario; sin motivo no', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const b = await emitida(dueno);
    expect((await pedir(`/panel/api/comprobantes/${b.id}/anular`, { cookie: dueno, cuerpo: { motivo: '' } })).status).toBe(422);
    const r = await pedir(`/panel/api/comprobantes/${b.id}/anular`, { cookie: dueno, cuerpo: { motivo: 'Error en el nombre' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, via: 'RESUMEN_DIARIO' });
  });

  it('cambiar contraseña: exige la actual y un código nuevo; cierra las otras sesiones', async () => {
    const u = await usuario();
    const otra = await entrar(u, pasoActual());
    const esta = await entrar(u, pasoActual() + 1);
    const cambiar = (cuerpo: Record<string, string>) => pedir('/panel/api/contrasena', { cookie: esta, cuerpo });
    expect((await cambiar({ actual: 'equivocada!!', nueva: 'otra clave segura', codigo: codigoTotp(u.secreto, pasoActual() - 1) })).status).toBe(422);
    // El último código usado (paso + 1) ya no vale.
    expect((await cambiar({ actual: CONTRASENA, nueva: 'otra clave segura', codigo: codigoTotp(u.secreto, pasoActual() + 1) })).status).toBe(422);
    // Con un código de un paso anterior al último usado tampoco: se exige uno nuevo. Se simula el siguiente minuto.
    await db.query(`UPDATE usuarios SET totp_ultimo_paso = totp_ultimo_paso - 2 WHERE id = $1`, [u.usuarioId]);
    expect((await cambiar({ actual: CONTRASENA, nueva: 'corta', codigo: codigoTotp(u.secreto, pasoActual()) })).status).toBe(422);
    expect((await cambiar({ actual: CONTRASENA, nueva: 'otra clave segura', codigo: codigoTotp(u.secreto, pasoActual()) })).status).toBe(200);
    expect((await pedir('/panel/api/yo', { cookie: esta })).status).toBe(200);
    expect((await pedir('/panel/api/yo', { cookie: otra })).status).toBe(401);
  });
});
