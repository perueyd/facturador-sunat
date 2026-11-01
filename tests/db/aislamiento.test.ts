/**
 * Aislamiento entre empresas (prueba de "espía"): el dueño de la empresa A intenta leer y
 * cambiar, por cada ruta del panel que recibe un id, datos de la empresa B. Todo debe
 * rechazarse y los datos de B deben quedar intactos. Si una ruta nueva olvida filtrar por
 * empresa, esta prueba es la que avisa.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/conexion.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { asignarEmpresa, crearUsuario, type Rol } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, activarSegundoPaso, crearEmpresa, prepararBase } from './base-prueba.js';

const CONTRASENA = 'clave del panel 2026';

describe.skipIf(!URL_PRUEBAS)('aislamiento entre empresas en el panel', () => {
  let db: Db;
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

  /** Usuario con 2FA activo y todos sus códigos libres para entrar. */
  async function usuario(rol: Rol, empresaId: string) {
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

  it('el dueño de A no ve ni cambia nada de la empresa B', async () => {
    const A = await nuevaEmpresa();
    const B = await nuevaEmpresa();
    const duenoA = await entrar(await usuario('DUENO', A.empresaId));
    const duenoB = await entrar(await usuario('DUENO', B.empresaId));
    const vendedorB = await usuario('VENDEDOR', B.empresaId);
    const json = async (r: Response) => { expect(r.status, await r.clone().text()).toBeLessThan(300); return r.json(); };

    // --- Datos de B ---
    const venta = await json(await pedir('/panel/api/comprobantes', { cookie: duenoB, cuerpo: {
      pedido: `PANEL-${crypto.randomUUID()}`, canal: 'WhatsApp', tipo: 'BOLETA',
      cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: 'CLIENTE DE B' }, items: [{ descripcion: 'Silla', cantidad: 1, precio: '100.00' }],
    } }));
    const cot = await json(await pedir('/panel/api/cotizaciones', { cookie: duenoB, cuerpo: {
      cliente: { tipoDocumento: 'NINGUNO', numero: '', nombre: 'Prospecto de B' }, items: [{ descripcion: 'Mesa', cantidad: '1', precio: '300' }], diasValidez: 7,
    } }));
    const cuenta = await json(await pedir('/panel/api/cuentas', { cookie: duenoB, cuerpo: { nombre: 'Cajón de B', medio: 'EFECTIVO' } }));
    const gasto = await json(await pedir('/panel/api/gastos', { cookie: duenoB, cuerpo: { monto: '20', categoria: 'TRANSPORTE', descripcion: 'Pasaje de B', medio: 'EFECTIVO', cuenta: cuenta.id } }));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
    await json(await pedir(`/panel/api/gastos/${gasto.id}/foto`, { cookie: duenoB, cuerpo: { imagen: `data:image/png;base64,${png.toString('base64')}` } }));
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    await json(await pedir('/panel/api/compras', { cookie: duenoB, cuerpo: {
      proveedor: { ruc: '20600000013', razonSocial: 'PROVEEDOR DE B' }, tipo: '01', serie: 'F001', numero: '7', fecha: hoy,
      igv: '18.00', total: '118.00', items: [{ descripcion: 'Madera', cantidad: '1', costoUnitario: '100.00' }], vence: hoy,
    } }));
    const deuda = (await json(await pedir('/panel/api/por-pagar', { cookie: duenoB }))).deudas[0];
    await json(await pedir(`/panel/api/compras/${deuda.compraId}/pagos`, { cookie: duenoB, cuerpo: { monto: '18', medio: 'EFECTIVO' } }));
    const pago = (await json(await pedir('/panel/api/por-pagar', { cookie: duenoB }))).deudas[0].pagos[0];

    // --- A intenta, ruta por ruta ---
    const rechazado = async (ruta: string, cuerpo?: unknown) => {
      const r = await pedir(ruta, { cookie: duenoA, ...(cuerpo === undefined ? {} : { cuerpo }) });
      expect([403, 404, 409, 422], `${ruta} respondió ${r.status}`).toContain(r.status);
    };
    await rechazado(`/panel/api/comprobantes/${venta.id}`);
    await rechazado(`/panel/api/comprobantes/${venta.id}/pdf`);
    await rechazado(`/panel/api/comprobantes/${venta.id}/pagos`, { medio: 'EFECTIVO', monto: '1.00' });
    await rechazado(`/panel/api/comprobantes/${venta.id}/devolucion`, { motivo: 'espía' });
    await rechazado(`/panel/api/comprobantes/${venta.id}/anular`, { motivo: 'espía' });
    await rechazado(`/panel/api/cotizaciones/${cot.id}/pdf`);
    await rechazado(`/panel/api/cotizaciones/${cot.id}/anular`, {});
    await rechazado(`/panel/api/cotizaciones/${cot.id}/convertida`, { comprobanteId: venta.id });
    await rechazado(`/panel/api/gastos/${gasto.id}/foto`);
    await rechazado(`/panel/api/gastos/${gasto.id}/foto`, { imagen: `data:image/png;base64,${png.toString('base64')}` });
    await rechazado(`/panel/api/gastos/${gasto.id}/anular`, { motivo: 'espía' });
    await rechazado(`/panel/api/compras/${deuda.compraId}/pagos`, { monto: '1', medio: 'EFECTIVO' });
    await rechazado(`/panel/api/pagos-compra/${pago.id}/anular`, { motivo: 'espía' });
    await rechazado(`/panel/api/cuentas/${cuenta.id}`, { nombre: 'Robada', medio: 'EFECTIVO', activa: false });
    await rechazado(`/panel/api/usuarios/${vendedorB.usuarioId}/comision`, { porcentaje: '99' });
    await rechazado(`/panel/api/usuarios/${vendedorB.usuarioId}/enlace`, {});
    // Un pago de A no puede salir de una cuenta de B.
    const ventaA = await json(await pedir('/panel/api/comprobantes', { cookie: duenoA, cuerpo: {
      pedido: `PANEL-${crypto.randomUUID()}`, canal: 'WhatsApp', tipo: 'BOLETA', items: [{ descripcion: 'X', cantidad: 1, precio: '10.00' }],
    } }));
    await rechazado(`/panel/api/comprobantes/${ventaA.id}/pagos`, { medio: 'EFECTIVO', cuenta: cuenta.id });
    await rechazado('/panel/api/gastos', { monto: '1', categoria: 'OTROS', descripcion: 'x', medio: 'EFECTIVO', cuenta: cuenta.id });

    // --- Las listas de A no muestran nada de B ---
    const textoDe = async (ruta: string) => JSON.stringify(await json(await pedir(ruta, { cookie: duenoA })));
    for (const ruta of ['/panel/api/comprobantes', '/panel/api/cotizaciones', '/panel/api/gastos', '/panel/api/por-pagar', '/panel/api/caja',
      '/panel/api/cuentas', '/panel/api/usuarios', '/panel/api/clientes/frecuentes', '/panel/api/venta-rapida', '/panel/api/compras']) {
      const t = await textoDe(ruta);
      for (const secreto of ['CLIENTE DE B', 'Prospecto de B', 'Pasaje de B', 'PROVEEDOR DE B', 'Cajón de B', 'Silla', vendedorB.email]) {
        expect(t, `${ruta} muestra "${secreto}"`).not.toContain(secreto);
      }
    }

    // --- Y los datos de B siguen intactos ---
    const b = (await db.query(
      `SELECT (SELECT estado FROM cotizaciones WHERE id = $1) AS cot,
              (SELECT anulado_en IS NULL FROM gastos WHERE id = $2) AS gasto_vivo,
              (SELECT anulado_en IS NULL FROM pagos_compra WHERE id = $3) AS pago_vivo,
              (SELECT activa FROM cuentas_cobro WHERE id = $4) AS cuenta_activa,
              (SELECT comision FROM usuario_empresa WHERE usuario_id = $5) AS comision,
              (SELECT count(*) FROM pagos WHERE comprobante_id = $6)::int AS pagos_venta`,
      [cot.id, gasto.id, pago.id, cuenta.id, vendedorB.usuarioId, venta.id],
    )).rows[0];
    expect(b).toEqual({ cot: 'VIGENTE', gasto_vivo: true, pago_vivo: true, cuenta_activa: true, comision: null, pagos_venta: 0 });
  });
});
