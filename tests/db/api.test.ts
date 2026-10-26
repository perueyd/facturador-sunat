/**
 * API HTTP de punta a punta: llave → emitir → enviar (SUNAT simulado) → consultar → PDF/XML/CDR → anular.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp, type DependenciasApi } from '../../src/api/app.js';
import { tokenComprobante } from '../../src/api/enlaces.js';
import { crearLlaveApi, revocarLlave } from '../../src/api/llaves.js';
import type { Db } from '../../src/db/conexion.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { ahoraLima } from '../../src/fechas.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { RUC_CLIENTE } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

const boleta = (pedido: string, extra: Record<string, unknown> = {}) => ({
  pedido,
  tipo: 'BOLETA',
  cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: 'JUAN PÉREZ' },
  items: [{ codigo: 'TAR-001', descripcion: 'Tarima 2 plazas', cantidad: 1, precio: '350.00' }],
  ...extra,
});

describe.skipIf(!URL_PRUEBAS)('API HTTP', () => {
  let db: Db;
  let f: Fixture;
  let llave: string;
  let dep: DependenciasApi;
  let app: ReturnType<typeof crearApp>;
  const sunat = new SunatSimulado();
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    await sunat.iniciar();
    dep = {
      db,
      claveCron: 'clave-cron-de-prueba',
      limitePorMinuto: 1000,
      servicios: {
        almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-api-'))),
        llaveMaestra,
        algoritmo: 'SHA256',
        entorno: { SUNAT_URL_BETA: sunat.url },
        ahora: () => new Date(Date.now() + 60_000),
        crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales, tiempoMaximoMs: 400 }),
      },
    };
    app = crearApp(dep);
  });
  afterAll(async () => {
    await sunat.detener();
    await db?.end();
  });
  beforeEach(async () => {
    sunat.reiniciar();
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
    await guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba(), clave: 'clave-de-prueba', llaveMaestra });
    llave = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda })).llave;
  });

  const pedir = (ruta: string, opciones: { metodo?: string; cuerpo?: unknown; llave?: string | null; crudo?: string } = {}) =>
    app.request(ruta, {
      method: opciones.metodo ?? (opciones.cuerpo !== undefined || opciones.crudo ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(opciones.llave === null ? {} : { Authorization: `Bearer ${opciones.llave ?? llave}` }),
      },
      ...(opciones.crudo ? { body: opciones.crudo } : opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
    });

  it('salud', async () => {
    expect((await app.request('/v1/salud')).status).toBe(200);
  });

  describe('autenticación', () => {
    it('sin llave, llave mal formada, llave inventada o revocada: 401', async () => {
      expect((await pedir('/v1/comprobantes?pedido=x', { llave: null })).status).toBe(401);
      expect((await pedir('/v1/comprobantes?pedido=x', { llave: 'cualquiercosa' })).status).toBe(401);
      expect((await pedir('/v1/comprobantes?pedido=x', { llave: `fk_000000000000_${'A'.repeat(43)}` })).status).toBe(401);
      const otra = await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda });
      await revocarLlave(db, f.empresaId, otra.prefijo);
      const r = await pedir('/v1/comprobantes?pedido=x', { llave: otra.llave });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: { codigo: 'NO_AUTORIZADO', mensaje: 'Llave de API inválida o revocada.' } });
    });

    it('canal desactivado: su llave deja de funcionar', async () => {
      await db.query(`UPDATE canales SET activo = false WHERE id = $1`, [f.canalTienda]);
      expect((await pedir('/v1/comprobantes', { cuerpo: boleta('P1') })).status).toBe(401);
    });

    it('la llave se guarda solo como huella (hash)', async () => {
      const secreto = llave.split('_').at(-1)!;
      const r = await db.query(`SELECT hash FROM api_llaves WHERE empresa_id = $1`, [f.empresaId]);
      expect(JSON.stringify(r.rows)).not.toContain(secreto);
    });

    it('solo canales de tipo API reciben llaves', async () => {
      await expect(crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalManual })).rejects.toThrow(/tipo API/);
    });
  });

  describe('enlace para el cliente', () => {
    it('abre el PDF sin llave; alterado, de otro comprobante o vencido: 404', async () => {
      // Como llega detrás de Render: http por dentro, https por fuera.
      const emitida = await app.request('http://facturador.ejemplo.pe/v1/comprobantes', {
        method: 'POST', body: JSON.stringify(boleta('ED-ENL')),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llave}`, 'X-Forwarded-Proto': 'https' },
      });
      const b = (await emitida.json()) as { id: string; enlaces: { cliente: string } };
      const enlace = new URL(b.enlaces.cliente);
      expect(enlace.origin).toBe('https://facturador.ejemplo.pe'); // la dirección pública, no la interna
      const abrir = (ruta: string) => app.request(ruta);
      const r = await abrir(enlace.pathname);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('application/pdf');

      const [id, vence, firma] = enlace.pathname.slice(3).split('.');
      const otro = (await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-ENL2') })).json()) as { id: string };
      expect((await abrir(`/c/${otro.id}.${vence}.${firma}`)).status).toBe(404); // la firma es de otro comprobante
      expect((await abrir(`/c/${id}.zzzzzzz.${firma}`)).status).toBe(404); // vigencia alargada a mano
      expect((await abrir(`/c/${id}.${vence}.${firma!.slice(0, -2)}xx`)).status).toBe(404);
      const vencido = tokenComprobante(llaveMaestra, b.id, new Date(Date.now() - 400 * 86_400_000));
      expect((await abrir(`/c/${vencido}`)).status).toBe(404);
    });
  });

  describe('emitir', () => {
    it('emite, envía a SUNAT al instante y responde 201 con el comprobante aceptado', async () => {
      const r = await pedir('/v1/comprobantes', { cuerpo: boleta('ED-1001') });
      expect(r.status).toBe(201);
      const b = (await r.json()) as Record<string, unknown>;
      expect(b).toMatchObject({ pedido: 'ED-1001', numero: 'B001-00000001', tipo: '03', estado: 'ACEPTADO', total: '350.00', igv: '53.39', repetido: false, estadoPago: 'PENDIENTE' });
      expect((b.sunat as { codigo: string }).codigo).toBe('0');
      expect(sunat.contar('sendBill')).toBe(1);
      // La marca por defecto del canal quedó registrada.
      const m = await db.query(`SELECT marca_id FROM comprobantes WHERE id = $1`, [b.id]);
      expect(m.rows[0].marca_id).toBe(f.marcaId);
    });

    it('con descuento (cupón u oferta): total rebajado, guardado y firmado con el descuento', async () => {
      const r = await pedir('/v1/comprobantes', { cuerpo: boleta('ED-DSC', { descuento: '50.00' }) });
      expect(r.status).toBe(201);
      const b = (await r.json()) as { id: string };
      expect(b).toMatchObject({ total: '300.00', descuento: '50.00', estado: 'ACEPTADO' });
      // El XML firmado sale de lo guardado en la base: el descuento sobrevive al viaje.
      const xml = await (await pedir(`/v1/comprobantes/${b.id}/xml`)).text();
      expect(xml).toContain('>02</cbc:AllowanceChargeReasonCode>');
      expect(xml).toContain('<cbc:PayableAmount currencyID="PEN">300.00</cbc:PayableAmount>');
      // Y nadie puede cambiarlo después.
      await expect(db.query(`UPDATE comprobantes SET descuento_global = 0, descuento_global_base = NULL WHERE id = $1`, [b.id])).rejects.toThrow(/no se puede modificar/);
      // "0.00" = sin descuento; un número (no texto) se rechaza.
      expect(await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-DSC0', { descuento: '0.00' }) })).json()).toMatchObject({ descuento: '0.00', total: '350.00' });
      expect((await pedir('/v1/comprobantes', { cuerpo: boleta('ED-DSCN', { descuento: 50 }) })).status).toBe(422);
    });

    it('el mismo pedido otra vez: 200, el mismo comprobante, sin volver a enviar', async () => {
      const a = (await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-2') })).json()) as { id: string };
      const r = await pedir('/v1/comprobantes', { cuerpo: boleta('ED-2') });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ id: a.id, repetido: true });
      expect(sunat.contar('sendBill')).toBe(1);
    });

    it('SUNAT caído al emitir: 201 con estado PENDIENTE_ENVIO; el cron lo envía después', async () => {
      sunat.colaBill.push({ modo: 'http500' });
      const r = (await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-3') })).json()) as { id: string; estado: string };
      expect(r.estado).toBe('PENDIENTE_ENVIO');
      dep.servicios.ahora = () => new Date(Date.now() + 10 * 60_000);
      const cron = await app.request('/v1/cola/procesar', { method: 'POST', headers: { Authorization: 'Bearer clave-cron-de-prueba' } });
      expect(cron.status).toBe(200);
      dep.servicios.ahora = () => new Date(Date.now() + 60_000);
      expect(((await (await pedir(`/v1/comprobantes/${r.id}`)).json()) as { estado: string }).estado).toBe('ACEPTADO');
    });

    it('factura al crédito con nota de crédito posterior', async () => {
      const factura = {
        pedido: 'ED-4', tipo: 'FACTURA',
        cliente: { tipoDocumento: 'RUC', numero: RUC_CLIENTE, nombre: 'CLIENTE EMPRESA S.A.C.' },
        items: [{ descripcion: 'Cabecera', cantidad: 1, precio: '1180.00' }],
        formaPago: { cuotas: [{ monto: '1180.00', vence: '2099-12-31' }] },
      };
      const fa = (await (await pedir('/v1/comprobantes', { cuerpo: factura })).json()) as { numero: string; estado: string };
      expect(fa).toMatchObject({ numero: 'F001-00000001', estado: 'ACEPTADO' });
      const nc = await pedir('/v1/comprobantes', {
        cuerpo: { pedido: 'ED-4-NC', tipo: 'NOTA_CREDITO', items: [{ descripcion: 'Cabecera devuelta', cantidad: 1, precio: '1180.00' }], notaCredito: { tipo: 'FACTURA', serie: 'F001', numero: 1, motivo: '06', descripcion: 'Devolución total' } },
      });
      expect(nc.status).toBe(201);
      expect(await nc.json()).toMatchObject({ numero: 'FC01-00000001', tipo: '07', estado: 'ACEPTADO' });
    });

    it('montos como número, datos mal escritos o cuerpo inválido: 422 con detalles en español', async () => {
      const comoNumero = await pedir('/v1/comprobantes', { cuerpo: boleta('X1', { items: [{ descripcion: 'A', cantidad: 1, precio: 59.9 }] }) });
      expect(comoNumero.status).toBe(422);
      expect(JSON.stringify(await comoNumero.json())).toContain('envía el monto como texto');

      const dniMalo = await pedir('/v1/comprobantes', { cuerpo: boleta('X2', { cliente: { tipoDocumento: 'DNI', numero: '123', nombre: 'A' } }) });
      expect(((await dniMalo.json()) as { error: { detalles: string[] } }).error.detalles.join(' ')).toMatch(/DNI "123" no es válido/);

      expect((await pedir('/v1/comprobantes', { crudo: 'esto no es json' })).status).toBe(422);
      expect((await pedir('/v1/comprobantes', { cuerpo: boleta('X3', { marca: 'No existe' }) })).status).toBe(422);
    });

    it('boleta sin cliente hasta S/ 700', async () => {
      const r = await pedir('/v1/comprobantes', { cuerpo: { pedido: 'ED-5', tipo: 'BOLETA', items: [{ descripcion: 'Almohada', cantidad: 2, precio: '59.90' }] } });
      expect(r.status).toBe(201);
    });

    it('pedido de más de 100 KB: 413', async () => {
      const r = await pedir('/v1/comprobantes', { crudo: JSON.stringify(boleta('G', { relleno: 'x'.repeat(110 * 1024) })) });
      expect(r.status).toBe(413);
    });
  });

  describe('consultar y descargar', () => {
    let id: string;
    beforeEach(async () => {
      id = ((await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-9') })).json()) as { id: string }).id;
    });

    it('por id y por número de pedido', async () => {
      expect(await (await pedir(`/v1/comprobantes/${id}`)).json()).toMatchObject({ id, pedido: 'ED-9' });
      expect(await (await pedir('/v1/comprobantes?pedido=ED-9')).json()).toMatchObject({ id });
      expect((await pedir('/v1/comprobantes?pedido=no-existe')).status).toBe(404);
      expect((await pedir('/v1/comprobantes/no-es-un-uuid')).status).toBe(404);
    });

    it('por pedido: si SUNAT rechazó el primero, devuelve el nuevo que lo reemplazó', async () => {
      await db.query(`UPDATE comprobantes SET estado = 'RECHAZADO' WHERE id = $1`, [id]);
      const nuevo = ((await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-9') })).json()) as { id: string }).id;
      expect(nuevo).not.toBe(id);
      expect(await (await pedir('/v1/comprobantes?pedido=ED-9')).json()).toMatchObject({ id: nuevo });
    });

    it('PDF: formato del canal por defecto, o el que se pida', async () => {
      const a4 = await pedir(`/v1/comprobantes/${id}/pdf`);
      expect(a4.status).toBe(200);
      expect(a4.headers.get('content-type')).toBe('application/pdf');
      expect(a4.headers.get('content-disposition')).toMatch(/-03-B001-1\.pdf"/);
      const ticket = await pedir(`/v1/comprobantes/${id}/pdf?formato=TICKET_80`);
      expect(ticket.headers.get('content-disposition')).toMatch(/-ticket\.pdf"/);
      expect((await pedir(`/v1/comprobantes/${id}/pdf?formato=CARTA`)).status).toBe(400);
    });

    it('XML firmado y CDR de SUNAT', async () => {
      const xml = await pedir(`/v1/comprobantes/${id}/xml`);
      expect(xml.status).toBe(200);
      expect(await xml.text()).toContain('<ds:Signature');
      const cdr = await pedir(`/v1/comprobantes/${id}/cdr`);
      expect(cdr.headers.get('content-type')).toBe('application/zip');
    });

    it('una empresa no puede ver comprobantes de otra (404, como si no existieran)', async () => {
      const otra = await crearEmpresa(db, '20100170338');
      const ajena = (await crearLlaveApi(db, { empresaId: otra.empresaId, canalId: otra.canalTienda })).llave;
      expect((await pedir(`/v1/comprobantes/${id}`, { llave: ajena })).status).toBe(404);
      expect((await pedir(`/v1/comprobantes/${id}/pdf`, { llave: ajena })).status).toBe(404);
      expect((await pedir('/v1/comprobantes?pedido=ED-9', { llave: ajena })).status).toBe(404);
    });
  });

  describe('permisos, anulación, límites y cron', () => {
    it('anular requiere el permiso "anular"', async () => {
      const id = ((await (await pedir('/v1/comprobantes', { cuerpo: boleta('ED-10', { fecha: ahoraLima().fecha }) })).json()) as { id: string }).id;
      const sinPermiso = await pedir(`/v1/comprobantes/${id}/anular`, { cuerpo: { motivo: 'Venta cancelada' } });
      expect(sinPermiso.status).toBe(403);
      const conPermiso = (await crearLlaveApi(db, { empresaId: f.empresaId, canalId: f.canalTienda, permisos: ['consultar', 'anular'] })).llave;
      const r = await pedir(`/v1/comprobantes/${id}/anular`, { cuerpo: { motivo: 'Venta cancelada' }, llave: conPermiso });
      expect(r.status).toBe(202);
      expect(await r.json()).toMatchObject({ estado: 'ANULACION_EN_PROCESO', via: 'RESUMEN_DIARIO' });
      // Una llave solo de consulta no puede emitir.
      expect((await pedir('/v1/comprobantes', { cuerpo: boleta('ED-11'), llave: conPermiso })).status).toBe(403);
    });

    it('límite de pedidos por minuto: 429', async () => {
      const limitada = crearApp({ ...dep, limitePorMinuto: 2 });
      const r = await Promise.all([1, 2, 3].map(() => limitada.request('/v1/comprobantes?pedido=x', { headers: { Authorization: `Bearer ${llave}` } })));
      expect(r.map((x) => x.status).sort()).toEqual([404, 404, 429]);
    });

    it('límite de intentos: tras muchas llaves equivocadas desde una dirección, 429 sin tocar la base', async () => {
      const app2 = crearApp({ ...dep, fallosPorMinuto: 3 });
      const intento = (ip: string, l = 'fk_000000000000_mala') =>
        app2.request('/v1/comprobantes?pedido=x', { headers: { Authorization: `Bearer ${l}`, 'X-Forwarded-For': `1.2.3.4, ${ip}` } });
      expect([(await intento('9.9.9.9')).status, (await intento('9.9.9.9')).status, (await intento('9.9.9.9')).status]).toEqual([401, 401, 401]);
      expect((await intento('9.9.9.9')).status).toBe(429);
      // Frenado aunque ahora traiga la llave correcta (podría haberla adivinado a la fuerza)…
      expect((await intento('9.9.9.9', llave)).status).toBe(429);
      // …pero otra dirección no se ve afectada. La IP real es la ÚLTIMA (la agrega el proxy).
      expect((await intento('8.8.8.8', llave)).status).toBe(404);
    });

    it('cabeceras de seguridad en las respuestas', async () => {
      const r = await app.request('/v1/salud');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    });

    it('cron: sin clave correcta no procesa', async () => {
      expect((await app.request('/v1/cola/procesar', { method: 'POST' })).status).toBe(401);
      expect((await app.request('/v1/cola/procesar', { method: 'POST', headers: { Authorization: 'Bearer otra' } })).status).toBe(401);
      const sinClave = crearApp({ ...dep, claveCron: undefined as unknown as string });
      expect((await sinClave.request('/v1/cola/procesar', { method: 'POST', headers: { Authorization: 'Bearer ' } })).status).toBe(401);
    });

    it('ruta inexistente: 401 sin llave (no revela qué rutas existen) y 404 con llave', async () => {
      expect((await app.request('/v1/nada')).status).toBe(401);
      const r = await pedir('/v1/nada');
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: { codigo: 'NO_ENCONTRADO' } });
    });
  });
});
