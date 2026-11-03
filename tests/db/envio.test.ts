/**
 * Flujo completo con PostgreSQL real y SUNAT simulado:
 * emitir → cola → firmar → enviar → CDR → estado; reintentos; anulaciones.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { ESPERAS_MINUTOS, procesarCola, reactivarTrabajo, type ServiciosEnvio } from '../../src/cola/procesar.js';
import { solicitarAnulacion } from '../../src/comprobantes/anular.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { Db } from '../../src/db/conexion.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { ahoraLima } from '../../src/fechas.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { solicitudBoleta, solicitudFactura } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('envío a SUNAT (simulado) con base de datos', () => {
  let db: Db;
  let f: Fixture;
  let s: ServiciosEnvio;
  const sunat = new SunatSimulado();
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  let reloj = new Date();
  const hoy = ahoraLima().fecha;

  beforeAll(async () => {
    db = await prepararBase();
    await sunat.iniciar();
    s = {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-envio-'))),
      llaveMaestra,
      algoritmo: 'SHA1',
      ahora: () => reloj,
      entorno: { SUNAT_URL_BETA: sunat.url },
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales, tiempoMaximoMs: 400 }),
    };
  });
  afterAll(async () => {
    await sunat.detener();
    await db?.end();
  });
  beforeEach(async () => {
    sunat.reiniciar();
    // Un minuto adelante: así los trabajos recién creados (con la hora real de la base) ya están vencidos.
    reloj = new Date(Date.now() + 60_000);
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
    await guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba(), clave: 'clave-de-prueba', llaveMaestra });
  });

  const avanzar = (minutos: number) => {
    reloj = new Date(reloj.getTime() + minutos * 60_000);
  };

  async function emitir(solicitud = solicitudBoleta({ fechaEmision: hoy })): Promise<string> {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalTienda, solicitud });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join());
    return r.guardado.id;
  }
  const estado = async (id: string) => (await db.query(`SELECT estado, sunat_codigo_respuesta, sunat_mensaje, sunat_observaciones FROM comprobantes WHERE id = $1`, [id])).rows[0];
  const trabajo = async (ref: string, tipo = 'COMPROBANTE') =>
    (await db.query(`SELECT estado, intentos, ultimo_error, proximo_intento_en FROM cola_envios WHERE referencia_id = $1 AND tipo = $2 ORDER BY creado_en DESC LIMIT 1`, [ref, tipo])).rows[0];
  const alertas = async (tipo: string) => (await db.query(`SELECT severidad, mensaje FROM alertas WHERE empresa_id = $1 AND tipo = $2`, [f.empresaId, tipo])).rows;

  it('catálogo de SUNAT cargado: 1710 códigos, con explicaciones simples para los frecuentes', async () => {
    const r = await db.query(`SELECT count(*)::int AS n, count(explicacion_es)::int AS explicados, count(*) FILTER (WHERE reintentable)::int AS reintentables FROM sunat_errores`);
    expect(r.rows[0]).toEqual({ n: 1710, explicados: 32, reintentables: 20 });
    const { explicarCodigo } = await import('../../src/sunat/errores.js');
    expect((await explicarCodigo(db, '0111')).mensaje).toMatch(/no tiene permiso.*permisos de comprobantes/);
    expect((await explicarCodigo(db, '3205')).mensaje).toBe('Código 3205: Debe consignar el tipo de operación Qué hacer: Corrige el dato indicado y emite un comprobante nuevo (el rechazado no tiene validez).');
    expect((await explicarCodigo(db, '0050', 'raro')).tipo).toBe('EXCEPCION'); // no catalogado: se clasifica por rango
  });

  it('aceptado: firma, envía, guarda el CDR y marca ACEPTADO', async () => {
    const id = await emitir();
    const v = await procesarCola(db, s);
    expect(v).toMatchObject({ procesados: 1, hechos: 1 });
    expect((await estado(id)).estado).toBe('ACEPTADO');
    expect((await trabajo(id)).estado).toBe('HECHO');
    const arch = await db.query(`SELECT tipo FROM archivos WHERE entidad_id = $1 ORDER BY tipo`, [id]);
    expect(arch.rows.map((x) => x.tipo)).toEqual(['CDR', 'XML_FIRMADO']);
    const ev = await db.query(`SELECT estado_nuevo FROM comprobante_eventos WHERE comprobante_id = $1 ORDER BY id`, [id]);
    expect(ev.rows.map((x) => x.estado_nuevo)).toEqual(['EMITIDO_LOCAL', 'EMITIDO_LOCAL', 'ACEPTADO']);
    const env = await db.query(`SELECT metodo, codigo_respuesta, resultado FROM envios_sunat WHERE referencia_id = $1`, [id]);
    expect(env.rows).toEqual([{ metodo: 'sendBill', codigo_respuesta: '0', resultado: 'ACEPTADO' }]);
    expect(sunat.recibidas[0]?.firmaValida).toBe(true);
  });

  it('aceptado con observaciones: queda válido y avisa en amarillo', async () => {
    sunat.colaBill.push({ modo: 'observar', notas: ['4252 - El dato ingresado como atributo @listName es incorrecto.'] });
    const id = await emitir();
    await procesarCola(db, s);
    const e = await estado(id);
    expect(e.estado).toBe('ACEPTADO_OBS');
    expect(e.sunat_observaciones).toEqual(['4252 - El dato ingresado como atributo @listName es incorrecto.']);
    expect((await alertas('COMPROBANTE_CON_OBSERVACIONES'))[0]?.severidad).toBe('AMARILLO');
  });

  it('rechazado (como SOAP Fault): RECHAZADO + alerta roja con explicación en español', async () => {
    sunat.colaBill.push({ modo: 'fault', codigo: '2800', mensaje: 'El dato ingresado en el tipo de documento de identidad del receptor no esta permitido.' });
    const id = await emitir();
    await procesarCola(db, s);
    const e = await estado(id);
    expect(e.estado).toBe('RECHAZADO');
    expect(e.sunat_codigo_respuesta).toBe('2800');
    const a = await alertas('COMPROBANTE_RECHAZADO');
    expect(a[0]?.severidad).toBe('ROJO');
    expect(a[0]?.mensaje).toMatch(/Código 2800: El tipo de documento del cliente no está permitido.*Qué hacer: Revisa el tipo de documento/);
    expect((await trabajo(id)).estado).toBe('HECHO'); // no se reintenta un rechazo
  });

  it('rechazado dentro del CDR', async () => {
    sunat.colaBill.push({ modo: 'rechazarCdr', codigo: '2801', descripcion: 'El DNI ingresado no cumple con el estandar.' });
    const id = await emitir();
    await procesarCola(db, s);
    expect((await estado(id)).estado).toBe('RECHAZADO');
    expect((await alertas('COMPROBANTE_RECHAZADO'))[0]?.mensaje).toMatch(/Corrige el DNI/);
  });

  it('SUNAT no responde: queda PENDIENTE y se reintenta solo con espera creciente hasta lograrlo', async () => {
    sunat.colaBill.push({ modo: 'colgar' }, { modo: 'cortar' }, { modo: 'http500' }, { modo: 'fault', codigo: '0100' });
    const id = await emitir();

    for (let i = 0; i < 4; i++) {
      const v = await procesarCola(db, s);
      expect(v.reintentos).toBe(1);
      expect((await estado(id)).estado).toBe('PENDIENTE_ENVIO');
      const t = await trabajo(id);
      expect(t.estado).toBe('PENDIENTE');
      expect(t.intentos).toBe(i + 1);
      const esperaMin = Math.round((new Date(t.proximo_intento_en).getTime() - reloj.getTime()) / 60_000);
      expect(esperaMin).toBe(ESPERAS_MINUTOS[i]);
      // Antes de que pase la espera no se vuelve a intentar.
      expect((await procesarCola(db, s)).procesados).toBe(0);
      avanzar(esperaMin);
    }
    await procesarCola(db, s);
    expect((await estado(id)).estado).toBe('ACEPTADO');
    expect(sunat.contar('sendBill')).toBe(5);
    // El mismo XML firmado en todos los intentos.
    expect(new Set(sunat.recibidas.map((r) => r.xml)).size).toBe(1);
    const env = await db.query(`SELECT resultado FROM envios_sunat WHERE referencia_id = $1 ORDER BY id`, [id]);
    expect(env.rows.map((x) => x.resultado)).toEqual(['REINTENTAR', 'REINTENTAR', 'REINTENTAR', 'REINTENTAR', 'ACEPTADO']);
  });

  it('muchos intentos fallidos: sigue reintentando, nunca lo descarta, y avisa', async () => {
    sunat.porDefectoBill = { modo: 'http500' };
    // Factura: su plazo legal es de 3 días (el de la boleta es 7), así el aviso de plazo llega en estas 60 h.
    const id = await emitir(solicitudFactura({ fechaEmision: hoy }));
    for (let i = 0; i < 12; i++) {
      await procesarCola(db, s);
      avanzar(300);
    }
    const t = await trabajo(id);
    expect(t.estado).toBe('PENDIENTE');
    expect(t.intentos).toBe(12);
    expect((await alertas('SUNAT_SIN_RESPUESTA'))).toHaveLength(1); // una sola alerta, no 6
    expect((await alertas('PLAZO_LEGAL_CERCANO'))[0]?.severidad).toBe('ROJO');
    sunat.porDefectoBill = { modo: 'aceptar' };
    await procesarCola(db, s);
    expect((await estado(id)).estado).toBe('ACEPTADO');
  });

  it('"ya registrado" (1033): NO se reenvía, queda para revisar', async () => {
    sunat.colaBill.push({ modo: 'fault', codigo: '1033', mensaje: 'El comprobante fue registrado previamente con otros datos' });
    const id = await emitir();
    const v = await procesarCola(db, s);
    expect(v.revisar).toBe(1);
    const t = await trabajo(id);
    expect(t.estado).toBe('FALLIDO_REVISAR');
    expect(t.ultimo_error).toMatch(/1033.*No se reenvía automáticamente/);
    avanzar(600);
    await procesarCola(db, s);
    expect(sunat.contar('sendBill')).toBe(1);
  });

  it('sin certificado: queda para revisar; al cargarlo y reactivar, se envía', async () => {
    await db.query(`UPDATE certificados SET activo = false WHERE empresa_id = $1`, [f.empresaId]);
    const id = await emitir();
    await procesarCola(db, s);
    const t = await db.query(`SELECT id, estado, ultimo_error FROM cola_envios WHERE referencia_id = $1`, [id]);
    expect(t.rows[0].estado).toBe('FALLIDO_REVISAR');
    expect(t.rows[0].ultimo_error).toMatch(/no tiene un certificado digital activo/);
    expect((await alertas('ENVIO_REQUIERE_REVISION'))).toHaveLength(1);
    expect(sunat.contar('sendBill')).toBe(0);

    await guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba({ ruc: 'nuevo' }), clave: 'clave-de-prueba', llaveMaestra });
    expect(await reactivarTrabajo(db, t.rows[0].id)).toBe(true);
    expect((await alertas('ENVIO_REQUIERE_REVISION'))).toHaveLength(1); // queda en el historial, resuelta
    await procesarCola(db, s);
    expect((await estado(id)).estado).toBe('ACEPTADO');
  });

  it('empresa en PRODUCCIÓN sin el doble candado: no envía nada', async () => {
    const u = await db.query(`INSERT INTO usuarios (email, nombre) VALUES ($1, 'Dueño') RETURNING id`, [`d${Date.now()}@x.pe`]);
    await db.query(`UPDATE empresas SET ambiente_sunat = 'PRODUCCION', produccion_autorizada_por = $2, produccion_autorizada_en = now() WHERE id = $1`, [f.empresaId, u.rows[0].id]);
    const id = await emitir();
    await procesarCola(db, s);
    expect((await trabajo(id)).ultimo_error).toMatch(/PRODUCCIÓN bloqueado/);
    expect(sunat.recibidas).toHaveLength(0);
  });

  it('dos procesadores a la vez: cada comprobante se envía una sola vez', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => emitir(solicitudBoleta({ fechaEmision: hoy, items: [{ descripcion: `P${i}`, unidad: 'NIU', cantidad: '1', precioUnitarioConIgv: '10.00', afectacion: '10' }] }))));
    const [a, b] = await Promise.all([procesarCola(db, s, 10), procesarCola(db, s, 10)]);
    expect(a.procesados + b.procesados).toBe(6);
    expect(sunat.contar('sendBill')).toBe(6);
    for (const id of ids) expect((await estado(id)).estado).toBe('ACEPTADO');
  });

  it('un procesador que se cayó a mitad: su trabajo se retoma después del bloqueo', async () => {
    const id = await emitir();
    await db.query(`UPDATE cola_envios SET estado = 'PROCESANDO', bloqueado_hasta = $2 WHERE referencia_id = $1`, [id, new Date(reloj.getTime() + 5 * 60_000)]);
    expect((await procesarCola(db, s)).procesados).toBe(0);
    avanzar(6);
    await procesarCola(db, s);
    expect((await estado(id)).estado).toBe('ACEPTADO');
  });

  describe('anulaciones', () => {
    async function aceptada(solicitud = solicitudFactura({ fechaEmision: hoy })): Promise<string> {
      const id = await emitir(solicitud);
      await procesarCola(db, s);
      expect((await estado(id)).estado).toBe('ACEPTADO');
      return id;
    }

    it('factura → comunicación de baja → ticket → en proceso → ANULADA', async () => {
      const id = await aceptada();
      // Otra empresa no puede anularlo aunque conozca su id (segunda barrera, además de la ruta).
      expect(await solicitarAnulacion(db, { empresaId: '00000000-0000-4000-8000-000000000000', comprobanteId: id, motivo: 'x', hoy }))
        .toMatchObject({ resultado: 'ERROR', errores: ['El comprobante no existe.'] });
      const r = await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'Error en el RUC del cliente', hoy });
      expect(r).toMatchObject({ resultado: 'SOLICITADA', via: 'BAJA', identificador: `RA-${hoy.replaceAll('-', '')}-1` });
      expect((await estado(id)).estado).toBe('ANULACION_EN_PROCESO');

      await procesarCola(db, s); // envía la baja
      expect(sunat.contar('sendSummary')).toBe(1);
      expect(sunat.recibidas.at(-1)?.fileName).toMatch(/-RA-\d{8}-1\.zip$/);
      expect(sunat.recibidas.at(-1)?.firmaValida).toBe(true);

      sunat.colaStatus.push({ modo: 'procesando' });
      avanzar(1);
      await procesarCola(db, s); // consulta: aún en proceso
      expect((await estado(id)).estado).toBe('ANULACION_EN_PROCESO');
      avanzar(2);
      await procesarCola(db, s); // consulta: aceptada
      expect((await estado(id)).estado).toBe('ANULADO');
      const ev = await db.query(`SELECT motivo FROM comprobante_eventos WHERE comprobante_id = $1 AND estado_nuevo = 'ANULACION_EN_PROCESO'`, [id]);
      expect(ev.rows[0].motivo).toBe('Error en el RUC del cliente');
    });

    it('boleta → resumen diario con estado 3', async () => {
      const id = await aceptada(solicitudBoleta({ fechaEmision: hoy }));
      const r = await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'Venta cancelada', hoy });
      expect(r).toMatchObject({ resultado: 'SOLICITADA', via: 'RESUMEN_DIARIO' });
      await procesarCola(db, s);
      expect(sunat.recibidas.at(-1)?.fileName).toMatch(/-RC-\d{8}-1\.zip$/);
      expect(sunat.recibidas.at(-1)?.xml).toContain('<cbc:ConditionCode>3</cbc:ConditionCode>');
      avanzar(1);
      await procesarCola(db, s);
      expect((await estado(id)).estado).toBe('ANULADO');
    });

    it('SUNAT rechaza la anulación: el comprobante sigue vigente (ACEPTADO) y avisa', async () => {
      const id = await aceptada();
      await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'Error', hoy });
      await procesarCola(db, s);
      sunat.colaStatus.push({ modo: 'rechazado', codigo: '2108', descripcion: 'Presentacion fuera de fecha' });
      avanzar(1);
      await procesarCola(db, s);
      expect((await estado(id)).estado).toBe('ACEPTADO');
      expect((await alertas('ANULACION_RECHAZADA'))[0]?.mensaje).toMatch(/sigue vigente.*2108/);
    });

    it('dos bajas el mismo día: correlativos 1 y 2', async () => {
      const a = await aceptada();
      const b = await aceptada();
      const ra = await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: a, motivo: 'x', hoy });
      const rb = await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: b, motivo: 'y', hoy });
      expect([ra, rb].map((r) => (r.resultado === 'SOLICITADA' ? r.identificador.split('-')[2] : ''))).toEqual(['1', '2']);
    });

    it('no se anula lo que no fue aceptado, ni dos veces, ni fuera de plazo, ni sin motivo', async () => {
      const pendiente = await emitir();
      expect((await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: pendiente, motivo: 'x', hoy })).resultado).toBe('ERROR');

      const id = await aceptada();
      expect(await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: '  ', hoy })).toMatchObject({ resultado: 'ERROR' });
      const lejos = new Date(Date.parse(`${hoy}T12:00:00Z`) + 8 * 86_400_000).toISOString().slice(0, 10);
      const tarde = await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'x', hoy: lejos });
      expect(tarde).toEqual({ resultado: 'ERROR', errores: [expect.stringMatching(/Pasó el plazo de 7 días.*nota de crédito/)] });
      expect((await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'x', hoy })).resultado).toBe('SOLICITADA');
      const otra = await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'x', hoy });
      expect(otra).toEqual({ resultado: 'ERROR', errores: [expect.stringMatching(/en proceso de anulación/)] });
    });
  });
});
