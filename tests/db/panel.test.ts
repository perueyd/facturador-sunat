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
import { asignarEmpresa, crearUsuario, type Rol } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, activarSegundoPaso, crearEmpresa, liberarCodigos, prepararBase, type Fixture } from './base-prueba.js';

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

  /** Usuario con 2FA activo y todos sus códigos libres para entrar. */
  async function usuario(rol: Rol = 'VENDEDOR', empresaId = f.empresaId) {
    const email = `u${++n}@prueba.pe`;
    const { usuarioId, secreto } = await crearUsuario(db, { email, nombre: `Usuario ${n}`, contrasena: CONTRASENA, llaveMaestra });
    await asignarEmpresa(db, usuarioId, empresaId, rol);
    await activarSegundoPaso(db, usuarioId, secreto, llaveMaestra);
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
    // Paso fijo: si el reloj cambia de bloque de 30 s entre las dos entradas, no sería el mismo código.
    const p = pasoActual();
    await entrar(u, p);
    const r = await pedir('/panel/api/entrar', { cuerpo: { email: u.email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, p) } });
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
    const p = pasoActual();
    const cookie = await entrar(u, p);
    expect((await pedir('/panel/api/salir', { cookie, cuerpo: {} })).status).toBe(200);
    expect((await pedir('/panel/api/yo', { cookie })).status).toBe(401);

    const cookie2 = await entrar(u, p + 1);
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
    // Paso fijo: si el reloj cambia de bloque de 30 s a mitad de la prueba, "el siguiente" no se corre.
    const p = pasoActual();
    const otra = await entrar(u, p);
    const esta = await entrar(u, p + 1);
    const cambiar = (cuerpo: Record<string, string>) => pedir('/panel/api/contrasena', { cookie: esta, cuerpo });
    expect((await cambiar({ actual: 'equivocada!!', nueva: 'otra clave segura', codigo: codigoTotp(u.secreto, p - 1) })).status).toBe(422);
    // El último código usado (paso + 1) ya no vale.
    expect((await cambiar({ actual: CONTRASENA, nueva: 'otra clave segura', codigo: codigoTotp(u.secreto, p + 1) })).status).toBe(422);
    // Con un código de un paso anterior al último usado tampoco: se exige uno nuevo. Se simula el siguiente minuto.
    await db.query(`UPDATE usuarios SET totp_ultimo_paso = totp_ultimo_paso - 2 WHERE id = $1`, [u.usuarioId]);
    expect((await cambiar({ actual: CONTRASENA, nueva: 'corta', codigo: codigoTotp(u.secreto, p) })).status).toBe(422);
    expect((await cambiar({ actual: CONTRASENA, nueva: 'otra clave segura', codigo: codigoTotp(u.secreto, p) })).status).toBe(200);
    expect((await pedir('/panel/api/yo', { cookie: esta })).status).toBe(200);
    expect((await pedir('/panel/api/yo', { cookie: otra })).status).toBe(401);
  });

  // ---------- Compras, crédito, cobros y stock ----------

  it('compra de proveedor: suma su IGV al mes; contador sí, vendedor no; no se repite', async () => {
    const contador = await entrar(await usuario('CONTADOR'));
    const vendedor = await entrar(await usuario('VENDEDOR'));
    const hoy = new Date().toISOString().slice(0, 10);
    const compra = { proveedor: { ruc: '20600000013', razonSocial: 'MADERAS DEL SUR S.A.C.' }, tipo: '01', serie: 'F001', numero: '77', fecha: hoy,
      igv: '18.00', total: '118.00', items: [{ descripcion: 'Planchas de melamina', cantidad: '2', costoUnitario: '50.00' }] };
    expect((await pedir('/panel/api/compras', { cookie: vendedor, cuerpo: compra })).status).toBe(403);
    expect((await pedir('/panel/api/compras', { cookie: contador, cuerpo: { ...compra, total: '119.00' } })).status).toBe(422);
    expect((await pedir('/panel/api/compras', { cookie: contador, cuerpo: compra })).status).toBe(201);
    expect((await pedir('/panel/api/compras', { cookie: contador, cuerpo: compra })).status).toBe(422);
    expect((await (await pedir('/panel/api/compras', { cookie: contador })).json()).compras[0]).toMatchObject({ numero: 'F001-77', igv: '18.00' });
    expect(await (await pedir('/panel/api/proveedores?ruc=20600000013', { cookie: contador })).json()).toEqual({ razonSocial: 'MADERAS DEL SUR S.A.C.' });
    expect((await (await pedir('/panel/api/yo', { cookie: contador })).json()).igvTasa).toMatch(/^0\.18/);
  });

  it('venta al crédito con cuotas y cobro del saldo después', async () => {
    const cookie = await entrar(await usuario('DUENO'));
    const vence = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
    const r = await pedir('/panel/api/comprobantes', { cookie, cuerpo: boleta({
      tipo: 'FACTURA', cliente: { tipoDocumento: 'RUC', numero: '20600000013', nombre: 'CLIENTE EMPRESA S.A.C.' },
      formaPago: { cuotas: [{ monto: '220.00', vence }] },
    }) });
    expect(r.status).toBe(201);
    const f1 = await r.json();
    expect(f1).toMatchObject({ numero: 'F001-00000001', saldo: '220.00' });
    const lista = (await (await pedir('/panel/api/por-cobrar', { cookie })).json()).porCobrar;
    expect(lista[0]).toMatchObject({ numero: 'F001-00000001', saldo: '220.00', proximaCuota: vence });

    expect((await pedir(`/panel/api/comprobantes/${f1.id}/pagos`, { cookie, cuerpo: { medio: 'BITCOIN' } })).status).toBe(422);
    const p1 = await (await pedir(`/panel/api/comprobantes/${f1.id}/pagos`, { cookie, cuerpo: { medio: 'YAPE', monto: '100.00', referencia: 'OP-1' } })).json();
    expect(p1.saldo).toBe('120.00');
    // El mismo nº de operación no se registra dos veces.
    expect((await (await pedir(`/panel/api/comprobantes/${f1.id}/pagos`, { cookie, cuerpo: { medio: 'YAPE', monto: '100.00', referencia: 'OP-1' } })).json()).saldo).toBe('120.00');
    const p2 = await (await pedir(`/panel/api/comprobantes/${f1.id}/pagos`, { cookie, cuerpo: { medio: 'EFECTIVO' } })).json();
    expect(p2).toMatchObject({ saldo: '0.00', estadoPago: 'PAGADO' });
    expect((await (await pedir('/panel/api/por-cobrar', { cookie })).json()).porCobrar).toEqual([]);
  });

  it('stock: crear producto, ajustar con motivo y verlo; solo dueño/administrador cambia', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const vendedor = await entrar(await usuario('VENDEDOR'));
    const producto = { sku: 'cab-milan', nombre: 'Cabecera Milán', precio: '220.00', controlaStock: true, stockMinimo: '2' };
    expect((await pedir('/panel/api/productos', { cookie: vendedor, cuerpo: producto })).status).toBe(403);
    expect((await pedir('/panel/api/productos', { cookie: dueno, cuerpo: producto })).status).toBe(201);
    expect((await pedir('/panel/api/stock/ajuste', { cookie: dueno, cuerpo: { sku: 'CAB-MILAN', cantidad: '5', motivo: '' } })).status).toBe(422);
    expect(await (await pedir('/panel/api/stock/ajuste', { cookie: dueno, cuerpo: { sku: 'CAB-MILAN', cantidad: '5', motivo: 'Conteo físico' } })).json()).toMatchObject({ stock: '5' });
    await pedir('/panel/api/comprobantes', { cookie: vendedor, cuerpo: boleta({ items: [{ codigo: 'CAB-MILAN', descripcion: 'Cabecera Milán', cantidad: 4, precio: '220.00' }] }) });
    const stock = (await (await pedir('/panel/api/stock', { cookie: vendedor })).json()).stock;
    expect(stock).toEqual([expect.objectContaining({ sku: 'CAB-MILAN', stock: '1', bajoMinimo: true })]);
  });

  it('estadísticas: dueño y contador sí, vendedor no; se pueden apagar', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const contador = await entrar(await usuario('CONTADOR'));
    const vendedor = await entrar(await usuario('VENDEDOR'));
    await emitida(dueno);
    const e = await (await pedir('/panel/api/estadisticas', { cookie: dueno })).json();
    expect(e.hoy.comprobantes).toBeGreaterThan(0);
    expect(e.meses).toHaveLength(6);
    expect((await pedir('/panel/api/estadisticas', { cookie: contador })).status).toBe(200);
    expect((await pedir('/panel/api/estadisticas', { cookie: vendedor })).status).toBe(403);
    expect((await (await pedir('/panel/api/yo', { cookie: vendedor })).json()).verEstadisticas).toBe(false);
    await db.query(`UPDATE empresas SET modulos_desactivados = '{estadisticas}' WHERE id = $1`, [f.empresaId]);
    expect((await pedir('/panel/api/estadisticas', { cookie: dueno })).status).toBe(403);
    expect((await (await pedir('/panel/api/yo', { cookie: dueno })).json()).verEstadisticas).toBe(false);
  });

  it('reposición y Kardex: dueño y contador sí, vendedor no', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const vendedor = await entrar(await usuario('VENDEDOR'));
    const r = await (await pedir('/panel/api/reposicion', { cookie: dueno })).json();
    expect(r.resumen).toBeDefined();
    expect(Array.isArray(r.proveedores)).toBe(true);
    expect((await pedir('/panel/api/reposicion', { cookie: vendedor })).status).toBe(403);
    expect((await pedir('/panel/api/kardex?sku=NADA', { cookie: dueno })).status).toBe(404);
    expect((await pedir('/panel/api/proveedores/dias', { cookie: dueno, cuerpo: { ruc: '20600000013', dias: '999' } })).status).toBe(422);
    expect((await (await pedir('/panel/api/yo', { cookie: vendedor })).json()).verInventario).toBe(false);
  });

  it('función "compras" apagada: 403 aunque se llame directo', async () => {
    const cookie = await entrar(await usuario('DUENO'));
    await db.query(`UPDATE empresas SET modulos_desactivados = '{compras}' WHERE id = $1`, [f.empresaId]);
    expect((await pedir('/panel/api/compras', { cookie })).status).toBe(403);
    expect((await (await pedir('/panel/api/yo', { cookie })).json()).puedeComprar).toBe(false);
  });

  it('logo: solo PNG/JPG reales, solo dueño/administrador; sale en el PDF', async () => {
    const { PNG } = await import('pngjs');
    const png = new PNG({ width: 40, height: 20 });
    png.data.fill(120);
    const imagen = PNG.sync.write(png).toString('base64');
    const vendedor = await entrar(await usuario('VENDEDOR'));
    const dueno = await entrar(await usuario('DUENO'));
    expect((await pedir('/panel/api/logo', { cookie: vendedor, cuerpo: { imagen } })).status).toBe(403);
    expect((await pedir('/panel/api/logo', { cookie: dueno, cuerpo: { imagen: Buffer.from('<svg onload=x>').toString('base64') } })).status).toBe(422);
    const b = await emitida(dueno);
    // Cuántas imágenes trae el PDF (el QR ya es una): con logo debe haber más.
    const imagenes = async () => (Buffer.from(await (await pedir(`/panel/api/comprobantes/${b.id}/pdf`, { cookie: dueno })).arrayBuffer())
      .toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;
    const antes = await imagenes();
    expect((await pedir('/panel/api/logo', { cookie: dueno, cuerpo: { imagen: `data:image/png;base64,${imagen}` } })).status).toBe(200);
    expect(await imagenes()).toBeGreaterThan(antes);
  });

  // ---------- Empresas, certificado y usuarios desde el panel ----------

  const desdeBase32 = (texto: string) => {
    let bits = '';
    for (const ch of texto) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0');
    return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  };

  it('dueño invita a un vendedor con un enlace: el vendedor crea su contraseña, activa su app y entra', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const admin = await entrar(await usuario('ADMIN'));
    const nuevo = { email: `vendedor${++n}@prueba.pe`, nombre: 'Vendedora', rol: 'VENDEDOR' };
    expect((await pedir('/panel/api/usuarios', { cookie: admin, cuerpo: nuevo })).status).toBe(403);
    expect((await pedir('/panel/api/usuarios', { cookie: dueno, cuerpo: { ...nuevo, rol: 'DUENO' } })).status).toBe(422);
    const r = await pedir('/panel/api/usuarios', { cookie: dueno, cuerpo: nuevo });
    expect(r.status).toBe(201);
    const d = await r.json();
    const token = /#invitacion=([\w-]+)$/.exec(d.enlace)![1]!;
    // El token no queda guardado: solo su huella.
    expect((await db.query(`SELECT 1 FROM invitaciones WHERE token_hash = convert_to($1, 'UTF8')`, [token])).rowCount).toBe(0);
    expect(await (await pedir(`/panel/api/invitacion?token=${token}`)).json()).toMatchObject({ email: nuevo.email, nombre: 'Vendedora', rol: 'VENDEDOR' });
    // Sin terminar, no entra (no tiene contraseña).
    expect((await pedir('/panel/api/entrar', { cuerpo: { email: nuevo.email, contrasena: CONTRASENA, codigo: '000000' } })).status).toBe(401);

    // Un enlace nuevo anula el anterior.
    const otro = await (await pedir(`/panel/api/usuarios/${d.usuarioId}/enlace`, { cookie: dueno, cuerpo: {} })).json();
    const token2 = /#invitacion=([\w-]+)$/.exec(otro.enlace)![1]!;
    expect((await pedir('/panel/api/invitacion', { cuerpo: { token, contrasena: CONTRASENA } })).status).toBe(404);
    expect((await pedir('/panel/api/invitacion', { cuerpo: { token: token2, contrasena: 'corta' } })).status).toBe(422);
    const qr = await (await pedir('/panel/api/invitacion', { cuerpo: { token: token2, contrasena: CONTRASENA } })).json();
    const secreto = desdeBase32(qr.clave);
    expect((await pedir('/panel/api/invitacion/activar', { cuerpo: { token: token2, codigo: '000000' } })).status).toBe(422);
    const act = await (await pedir('/panel/api/invitacion/activar', { cuerpo: { token: token2, codigo: codigoTotp(secreto, pasoActual()) } })).json();
    expect(act.codigosRespaldo).toHaveLength(10);
    await liberarCodigos(db, d.usuarioId);
    // El enlace ya se usó; y ya activado, no se le puede generar otro.
    expect((await pedir('/panel/api/invitacion/activar', { cuerpo: { token: token2, codigo: codigoTotp(secreto, pasoActual()) } })).status).toBe(404);
    expect((await pedir(`/panel/api/usuarios/${d.usuarioId}/enlace`, { cookie: dueno, cuerpo: {} })).status).toBe(409);

    const cookie = await entrar({ email: nuevo.email, secreto });
    expect(await (await pedir('/panel/api/yo', { cookie })).json()).toMatchObject({ puedeEmitir: true, esDueno: false });
    const lista = (await (await pedir('/panel/api/usuarios', { cookie: dueno })).json()).usuarios;
    expect(lista.find((u: { email: string }) => u.email === nuevo.email)).toMatchObject({ rol: 'VENDEDOR', pendiente: false });
  });

  it('invitación: no se puede reclamar la cuenta pendiente de otra empresa; un enlace vencido no sirve', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const email = `pendiente${++n}@prueba.pe`;
    const d = await (await pedir('/panel/api/usuarios', { cookie: dueno, cuerpo: { email, nombre: 'X', rol: 'VENDEDOR' } })).json();
    const otra = await crearEmpresa(db, '20600000013');
    const ajeno = await usuario('DUENO');
    await db.query(`UPDATE usuario_empresa SET empresa_id = $2 WHERE usuario_id = $1`, [ajeno.usuarioId, otra.empresaId]);
    const cookieAjeno = await entrar(ajeno);
    await pedir('/panel/api/empresa', { cookie: cookieAjeno, cuerpo: { empresaId: otra.empresaId } });
    const r = await pedir('/panel/api/usuarios', { cookie: cookieAjeno, cuerpo: { email, nombre: 'X', rol: 'ADMIN' } });
    expect(r.status).toBe(422);
    expect((await r.json()).error.mensaje).toMatch(/otra empresa/);

    await db.query(`UPDATE invitaciones SET expira_en = now() - interval '1 second' WHERE usuario_id = $1`, [d.usuarioId]);
    const token = /#invitacion=([\w-]+)$/.exec(d.enlace)![1]!;
    expect((await pedir(`/panel/api/invitacion?token=${token}`)).status).toBe(404);
  });

  it('lista de configuración y usuario SOL desde el panel', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const vendedor = await entrar(await usuario('VENDEDOR'));
    expect((await pedir('/panel/api/configuracion', { cookie: vendedor })).status).toBe(403);
    const pasos = (await (await pedir('/panel/api/configuracion', { cookie: dueno })).json()).pasos as { clave: string; listo: boolean }[];
    expect(pasos.map((p) => p.clave)).toEqual(['datos', 'certificado', 'prueba', 'logo', 'sol', 'produccion']);
    expect((await pedir('/panel/api/sol', { cookie: vendedor, cuerpo: { usuario: 'FACTURA01', clave: 'clave1234' } })).status).toBe(403);
    expect((await pedir('/panel/api/sol', { cookie: dueno, cuerpo: { usuario: 'FACTURA01', clave: 'corta' } })).status).toBe(422);
    expect((await pedir('/panel/api/sol', { cookie: dueno, cuerpo: { usuario: 'FACTURA-01', clave: 'clave1234' } })).status).toBe(422);
    expect((await pedir('/panel/api/sol', { cookie: dueno, cuerpo: { usuario: 'factura01', clave: 'clave1234' } })).status).toBe(200);
    const despues = (await (await pedir('/panel/api/configuracion', { cookie: dueno })).json()).pasos as { clave: string; listo: boolean }[];
    expect(despues.find((p) => p.clave === 'sol')!.listo).toBe(true);
    // La clave queda cifrada, nunca en texto.
    const guardado = (await db.query(`SELECT usuario_sol, clave_cifrada FROM credenciales_sol WHERE empresa_id = $1`, [f.empresaId])).rows[0];
    expect(guardado.usuario_sol).toBe('FACTURA01');
    expect(Buffer.from(guardado.clave_cifrada).toString('utf8')).not.toContain('clave1234');
  });

  it('certificado desde el panel: solo el dueño; contraseña equivocada se explica', async () => {
    const dueno = await entrar(await usuario('DUENO'));
    const admin = await entrar(await usuario('ADMIN'));
    const pfx = crearPfxPrueba().toString('base64');
    expect((await pedir('/panel/api/certificado', { cookie: admin, cuerpo: { pfx, clave: 'clave-de-prueba' } })).status).toBe(403);
    const mal = await pedir('/panel/api/certificado', { cookie: dueno, cuerpo: { pfx, clave: 'otra' } });
    expect(mal.status).toBe(422);
    expect((await mal.json()).error.mensaje).toMatch(/contraseña/);
    const ok = await pedir('/panel/api/certificado', { cookie: dueno, cuerpo: { pfx: `data:application/x-pkcs12;base64,${pfx}`, clave: 'clave-de-prueba' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).vence).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('alta de empresa: solo administrador de la plataforma; no pisa una existente', async () => {
    const u = await usuario('DUENO');
    const cookie = await entrar(u);
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const nueva = { ruc: base + digitoVerificadorRuc(base), razonSocial: 'NUEVO NEGOCIO S.A.C.', direccion: 'AV. NUEVA 1', distrito: 'LIMA', provincia: 'LIMA',
      departamento: 'LIMA', ubigeo: '150101', regimen: 'MYPE_TRIBUTARIO', regimenDesde: '2026-01-01' };
    expect((await pedir('/panel/api/empresas', { cookie, cuerpo: nueva })).status).toBe(403);
    await db.query(`UPDATE usuarios SET admin_plataforma = true WHERE id = $1`, [u.usuarioId]);
    expect((await pedir('/panel/api/empresas', { cookie, cuerpo: { ...nueva, ruc: '20123456789' } })).status).toBe(422);
    expect((await pedir('/panel/api/empresas', { cookie, cuerpo: nueva })).status).toBe(201);
    const yo = await (await pedir('/panel/api/yo', { cookie })).json();
    expect(yo.empresa).toMatchObject({ razonSocial: 'NUEVO NEGOCIO S.A.C.', rol: 'DUENO' });
    expect(yo.empresas).toHaveLength(2);
    expect((await pedir('/panel/api/empresas', { cookie, cuerpo: { ...nueva, razonSocial: 'OTRA COSA' } })).status).toBe(409);
  });

  it('"mantener mi sesión iniciada": 30 días en vez de 12 horas; cerrar las demás sesiones', async () => {
    const u = await usuario();
    const dias = async (recordar: boolean, paso: number) => {
      const r = await pedir('/panel/api/entrar', { cuerpo: { email: u.email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, paso), recordar } });
      expect(r.status).toBe(200);
      const galleta = r.headers.get('set-cookie') ?? '';
      const expira = Date.parse(/Expires=([^;]+)/i.exec(galleta)![1]!);
      return { cookie: galleta.split(';')[0]!, horas: Math.round((expira - Date.now()) / 3_600_000) };
    };
    const p = pasoActual();
    const corta = await dias(false, p);
    const larga = await dias(true, p + 1);
    expect(corta.horas).toBe(12);
    expect(larga.horas).toBe(30 * 24);
    const r = await (await pedir('/panel/api/sesiones/cerrar-otras', { cookie: larga.cookie, cuerpo: {} })).json();
    expect(r.cerradas).toBe(1);
    expect((await pedir('/panel/api/yo', { cookie: corta.cookie })).status).toBe(401);
    expect((await pedir('/panel/api/yo', { cookie: larga.cookie })).status).toBe(200);
  });
});
