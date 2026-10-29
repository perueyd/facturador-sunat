/**
 * El facturador como servicio: planes, cobro y vigilancia.
 * Lo delicado es que el plan frene SOLO lo que debe (boletas y facturas nuevas) y nunca lo
 * que el cliente necesita para cumplir con SUNAT, y que un reintento de la tienda no falle.
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
import { ahoraLima } from '../../src/fechas.js';
import { asignarEmpresa, crearUsuario } from '../../src/panel/usuarios.js';
import { cambiarSuscripcion, clientes, iniciarPrueba, registrarPago, suscripcionDe } from '../../src/plataforma/suscripciones.js';
import { registrarError, revisarPlataforma, vigilarPlataforma } from '../../src/plataforma/vigilancia.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { RUC_EMPRESA } from '../ayudantes.js';
import { URL_PRUEBAS, activarSegundoPaso, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

const boleta = (pedido: string) => ({
  pedido, tipo: 'BOLETA', cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: 'JUAN PÉREZ' },
  items: [{ codigo: 'TAR-001', descripcion: 'Tarima 2 plazas', cantidad: 1, precio: '350.00' }],
});
const CONTRASENA = 'clave del dueño 2026';

describe.skipIf(!URL_PRUEBAS)('plataforma: planes, cobro y vigilancia', () => {
  let db: Db;
  let app: ReturnType<typeof crearApp>;
  let admin: { usuarioId: string; cookie: string };
  const hoy = ahoraLima().fecha;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const correos: Correo[] = [];
  let n = 0;

  /** Empresa nueva con RUC válido distinto cada vez. */
  async function empresa(): Promise<Fixture> {
    const base = `20${String(70_000_000 + ++n).padStart(8, '0')}`;
    return crearEmpresa(db, base + digitoVerificadorRuc(base));
  }
  async function usuario(empresaId: string, rol: 'DUENO' | 'VENDEDOR', plataforma = false) {
    const email = `p${++n}@prueba.pe`;
    const u = await crearUsuario(db, { email, nombre: 'Prueba', contrasena: CONTRASENA, llaveMaestra });
    await asignarEmpresa(db, u.usuarioId, empresaId, rol);
    await activarSegundoPaso(db, u.usuarioId, u.secreto, llaveMaestra);
    if (plataforma) await db.query(`UPDATE usuarios SET admin_plataforma = true WHERE id = $1`, [u.usuarioId]);
    const r = await app.request('http://localhost/panel/api/entrar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
      body: JSON.stringify({ email, contrasena: CONTRASENA, codigo: codigoTotp(u.secreto, pasoActual()) }),
    });
    expect(r.status).toBe(200);
    return { usuarioId: u.usuarioId, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  }
  const panel = (ruta: string, cookie: string, cuerpo?: unknown) => app.request(`http://localhost/panel/api${ruta}`, {
    method: cuerpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Panel': '1', Cookie: cookie },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });

  beforeAll(async () => {
    db = await prepararBase();
    app = crearApp({ db, enviarAlEmitir: false, servicios: {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-plataforma-'))), llaveMaestra, algoritmo: 'SHA256', entorno: {},
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales }),
    } });
    const propia = await crearEmpresa(db, RUC_EMPRESA);
    admin = await usuario(propia.empresaId, 'DUENO', true);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('empresa propia: sin plan ni límites; la de un cliente empieza con 14 días de prueba', async () => {
    const propia = await empresa();
    expect(await suscripcionDe(db, propia.empresaId)).toBeUndefined();
    const cliente = await empresa();
    await iniciarPrueba(db, { empresaId: cliente.empresaId, hoy });
    expect(await suscripcionDe(db, cliente.empresaId, hoy)).toMatchObject({ plan: 'EMPRENDEDOR', estado: 'PRUEBA', dias: 14, puedeEmitir: true, limiteMes: 150 });
  });

  it('estados por fecha: por vencer, días de gracia y vencido (este ya no emite)', async () => {
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy });
    await db.query(`UPDATE suscripciones SET estado = 'ACTIVA', vence_en = $2::date + 5 WHERE empresa_id = $1`, [f.empresaId, hoy]);
    expect((await suscripcionDe(db, f.empresaId, hoy))!.estado).toBe('POR_VENCER');
    await db.query(`UPDATE suscripciones SET vence_en = $2::date - 3 WHERE empresa_id = $1`, [f.empresaId, hoy]);
    expect(await suscripcionDe(db, f.empresaId, hoy)).toMatchObject({ estado: 'EN_GRACIA', puedeEmitir: true });
    await db.query(`UPDATE suscripciones SET vence_en = $2::date - 6 WHERE empresa_id = $1`, [f.empresaId, hoy]);
    const s = await suscripcionDe(db, f.empresaId, hoy);
    expect(s).toMatchObject({ estado: 'VENCIDA', puedeEmitir: false });
    expect(s!.motivo).toMatch(/Renueva tu plan/);
  });

  it('vencido: la API no emite boletas NUEVAS, pero un reintento del mismo pedido sí responde', async () => {
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy });
    const llave = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda })).llave;
    const emitir = (pedido: string) => app.request('/v1/comprobantes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llave}` }, body: JSON.stringify(boleta(pedido)),
    });
    expect((await emitir('PL-1')).status).toBe(201);
    await db.query(`UPDATE suscripciones SET vence_en = $2::date - 30 WHERE empresa_id = $1`, [f.empresaId, hoy]);
    const nuevo = await emitir('PL-2');
    expect(nuevo.status).toBe(403);
    expect((await nuevo.json()).error).toMatchObject({ codigo: 'PLAN_SIN_EMISION' });
    expect((await emitir('PL-1')).status).toBe(200);
    // Consultar lo ya emitido sigue funcionando.
    expect((await app.request('/v1/comprobantes?pedido=PL-1', { headers: { Authorization: `Bearer ${llave}` } })).status).toBe(200);
  });

  it('límite del mes y de usuarios del plan', async () => {
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy });
    await db.query(`INSERT INTO planes (codigo, nombre, precio_mensual, precio_anual, comprobantes_mes, usuarios_max) VALUES ('MINI', 'Mini', 1, 10, 1, 1)`);
    await db.query(`UPDATE suscripciones SET plan_codigo = 'MINI' WHERE empresa_id = $1`, [f.empresaId]);
    const llave = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda })).llave;
    const emitir = (pedido: string) => app.request('/v1/comprobantes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llave}` }, body: JSON.stringify(boleta(pedido)),
    });
    expect((await emitir('MINI-1')).status).toBe(201);
    const r = await emitir('MINI-2');
    expect(r.status).toBe(403);
    expect((await r.json()).error.mensaje).toMatch(/límite de tu plan Mini/);

    const dueno = await usuario(f.empresaId, 'DUENO');
    const otro = await panel('/usuarios', dueno.cookie, { email: 'nuevo@prueba.pe', rol: 'VENDEDOR', nombre: 'Nuevo', contrasena: 'clave segura 2026' });
    expect(otro.status).toBe(403);
    expect((await otro.json()).error.mensaje).toMatch(/permite 1 usuario/);
    const yo = await (await panel('/yo', dueno.cookie)).json();
    expect(yo.plan).toMatchObject({ plan: 'MINI', puedeEmitir: false, usoMes: 1, limiteMes: 1 });
  });

  it('registrar pago: suma desde el vencimiento si aún no venció; desde hoy si ya venció; queda en el historial', async () => {
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy: '2026-10-01' });
    // Vence el 15/10; paga el 10/10 → un mes desde el 15/10.
    const a = await registrarPago(db, { empresaId: f.empresaId, periodo: 'MENSUAL', medio: 'Yape', usuarioId: admin.usuarioId, hoy: '2026-10-10' });
    expect(a).toEqual({ hasta: '2026-11-15', monto: '39.00' });
    // Ya vencido: paga anual el 01/01/2027 → desde ese día.
    const b = await registrarPago(db, { empresaId: f.empresaId, periodo: 'ANUAL', plan: 'NEGOCIO', medio: 'Transferencia', usuarioId: admin.usuarioId, hoy: '2027-01-01' });
    expect(b).toEqual({ hasta: '2028-01-01', monto: '690.00' });
    expect(await suscripcionDe(db, f.empresaId, '2027-01-01')).toMatchObject({ plan: 'NEGOCIO', estado: 'ACTIVA' });
    await expect(db.query(`DELETE FROM pagos_suscripcion WHERE empresa_id = $1`, [f.empresaId])).rejects.toThrow(/solo inserción/);
    await expect(registrarPago(db, { empresaId: f.empresaId, periodo: 'MENSUAL', medio: '', usuarioId: admin.usuarioId })).rejects.toThrow(/cómo pagó/);
    await expect(cambiarSuscripcion(db, { empresaId: f.empresaId, usuarioId: admin.usuarioId, estado: 'SUSPENDIDA', motivo: '' })).rejects.toThrow(/motivo/);
    await cambiarSuscripcion(db, { empresaId: f.empresaId, usuarioId: admin.usuarioId, estado: 'SUSPENDIDA', motivo: 'No pagó' });
    expect((await suscripcionDe(db, f.empresaId, '2027-01-01'))!.puedeEmitir).toBe(false);
  });

  it('panel de la plataforma: solo su administrador; lista clientes y suma el ingreso mensual', async () => {
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy });
    await registrarPago(db, { empresaId: f.empresaId, periodo: 'ANUAL', medio: 'Yape', usuarioId: admin.usuarioId, hoy });
    const vendedor = await usuario(f.empresaId, 'VENDEDOR');
    expect((await panel('/plataforma', vendedor.cookie)).status).toBe(403);
    expect((await panel(`/plataforma/${f.empresaId}/pago`, vendedor.cookie, { periodo: 'MENSUAL', medio: 'Yape' })).status).toBe(403);

    const p = await (await panel('/plataforma', admin.cookie)).json();
    const fila = p.clientes.find((c: { empresaId: string }) => c.empresaId === f.empresaId);
    expect(fila.suscripcion).toMatchObject({ estado: 'ACTIVA', plan: 'EMPRENDEDOR' });
    expect(p.planes.map((x: { codigo: string }) => x.codigo)).toContain('NEGOCIO');
    // Quien paga anual cuenta como la doceava parte (390 / 12 = 32.50).
    const { resumen } = await clientes(db, hoy);
    expect(resumen.activos).toBeGreaterThanOrEqual(1);
    expect(resumen.ingresoMensual).toMatch(/\.\d{2}$/);

    expect((await panel('/plataforma/planes/NEGOCIO', admin.cookie, { mensual: '75.00', anual: '750.00', comprobantesMes: '', usuariosMax: '5' })).status).toBe(200);
    expect((await panel('/plataforma/planes/NEGOCIO', admin.cookie, { mensual: 'gratis', anual: '750.00' })).status).toBe(422);
    expect((await db.query(`SELECT precio_mensual::text, comprobantes_mes FROM planes WHERE codigo = 'NEGOCIO'`)).rows[0]).toEqual({ precio_mensual: '75.00', comprobantes_mes: null });

    expect((await panel(`/plataforma/${f.empresaId}/cambio`, admin.cookie, { estado: 'SUSPENDIDA', motivo: 'Prueba' })).status).toBe(200);
    expect((await panel('/plataforma/salud', admin.cookie)).status).toBe(200);
  });

  it('alta de empresa por el panel: la de un cliente con prueba; la propia, sin plan', async () => {
    const datos = (ruc: string, extra: Record<string, unknown>) => ({
      ruc, razonSocial: 'CLIENTE NUEVO S.A.C.', direccion: 'AV. UNO 1', distrito: 'LIMA', provincia: 'LIMA', departamento: 'LIMA',
      ubigeo: '150101', regimen: 'MYPE_TRIBUTARIO', regimenDesde: '2026-01-01', ...extra,
    });
    const ruc = (x: number) => { const base = `20${String(80_000_000 + x).padStart(8, '0')}`; return base + digitoVerificadorRuc(base); };
    const r1 = await (await panel('/empresas', admin.cookie, datos(ruc(1), { plan: 'NEGOCIO', contacto: '999 888 777' }))).json();
    expect(await suscripcionDe(db, r1.empresaId)).toMatchObject({ plan: 'NEGOCIO', estado: 'PRUEBA' });
    const r2 = await (await panel('/empresas', admin.cookie, datos(ruc(2), { propia: true }))).json();
    expect(await suscripcionDe(db, r2.empresaId)).toBeUndefined();
  });

  it('secciones por plan: Emprendedor no trae stock ni estadísticas (se ofrecen); al cambiar de plan se activan', async () => {
    // Un plan que ya no se ofrece no aparece como sugerencia (el de prueba "Mini" de otra prueba).
    await db.query(`UPDATE planes SET activo = false WHERE codigo = 'MINI'`);
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy });
    const dueno = await usuario(f.empresaId, 'DUENO');
    const yo = await (await panel('/yo', dueno.cookie)).json();
    expect(yo.empresa.modulos).toContain('cobros');
    expect(yo.empresa.modulos).not.toContain('productos');
    expect(yo.empresa.modulos).toContain('notas');
    expect(yo.bloqueadas).toEqual(expect.arrayContaining([expect.objectContaining({ seccion: 'productos', plan: 'Negocio' })]));
    expect((await panel('/stock', dueno.cookie)).status).toBe(403);
    expect((await panel('/estadisticas', dueno.cookie)).status).toBe(403);

    await cambiarSuscripcion(db, { empresaId: f.empresaId, usuarioId: admin.usuarioId, plan: 'NEGOCIO', motivo: 'Mejora de plan' });
    const despues = await (await panel('/yo', dueno.cookie)).json();
    expect(despues.empresa.modulos).toEqual(expect.arrayContaining(['productos', 'compras', 'estadisticas']));
    expect(despues.bloqueadas).toEqual([]);
    expect((await panel('/stock', dueno.cookie)).status).toBe(200);

    // El administrador cambia qué trae un plan; una sección inventada no se acepta.
    const precios = { mensual: '39.00', anual: '390.00', comprobantesMes: '150', usuariosMax: '2' };
    expect((await panel('/plataforma/planes/EMPRENDEDOR', admin.cookie, { ...precios, secciones: ['facturar'] })).status).toBe(422);
    expect((await panel('/plataforma/planes/EMPRENDEDOR', admin.cookie, { ...precios, secciones: ['cobros', 'estadisticas'] })).status).toBe(200);
    const plan = (await (await panel('/plataforma', admin.cookie)).json()).planes.find((x: { codigo: string }) => x.codigo === 'EMPRENDEDOR');
    expect(plan.secciones).toEqual(['cobros', 'estadisticas']);
    // La empresa propia (sin plan) tiene todo y nada bloqueado.
    expect((await (await panel('/yo', admin.cookie)).json()).bloqueadas).toEqual([]);
  });

  it('vigilancia: detecta planes por vencer y errores internos, y avisa UNA vez', async () => {
    const f = await empresa();
    await iniciarPrueba(db, { empresaId: f.empresaId, hoy, contacto: 'cliente@prueba.pe' });
    await db.query(`UPDATE suscripciones SET estado = 'ACTIVA', vence_en = $2::date + 2 WHERE empresa_id = $1`, [f.empresaId, hoy]);
    await registrarError(db, 'api', 'algo se rompió', '/v1/comprobantes');
    const problemas = await revisarPlataforma(db, hoy);
    expect(problemas.map((p) => p.tipo)).toEqual(expect.arrayContaining(['PLAN', 'ERRORES']));
    expect(problemas.find((p) => p.tipo === 'PLAN' && p.mensaje.includes('cliente@prueba.pe'))!.mensaje).toMatch(/vence en 2 día/);

    expect(await vigilarPlataforma(db, async (c) => void correos.push(c), hoy)).toBe(1);
    expect(correos.at(-1)!.para).toContain((await db.query(`SELECT lower(email) AS e FROM usuarios WHERE id = $1`, [admin.usuarioId])).rows[0].e);
    expect(correos.at(-1)!.texto).toMatch(/algo se rompió/);
    // La siguiente pasada del cron no repite lo mismo.
    expect(await vigilarPlataforma(db, async (c) => void correos.push(c), hoy)).toBe(0);
    // Si el correo falla, se reintenta en la próxima pasada.
    await registrarError(db, 'api', 'otro error', '/x');
    await expect(vigilarPlataforma(db, async () => { throw new Error('sin red'); }, hoy)).rejects.toThrow(/sin red/);
    expect(await vigilarPlataforma(db, async (c) => void correos.push(c), hoy)).toBe(1);
  });
});
