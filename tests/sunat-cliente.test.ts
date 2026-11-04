import { zipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prepararComprobante } from '../src/comprobantes/preparar.js';
import { leerPfx } from '../src/firma/certificado.js';
import { firmarXml } from '../src/firma/firmar.js';
import { clasificarRespuesta, leerCdr } from '../src/sunat/cdr.js';
import { ClienteSunatSoap, ErrorConexionSunat, ErrorRespuestaSunat, codigoDeFault, construirSobre } from '../src/sunat/cliente.js';
import { URL_BILL_SERVICE, urlServicio } from '../src/sunat/configuracion.js';
import { tipoPorRango } from '../src/sunat/errores.js';
import { comprimirXml, extraerXml } from '../src/sunat/zip.js';
import { generarXmlComprobante } from '../src/xml/comprobante.js';
import { nombreArchivoComprobante } from '../src/xml/nombres.js';
import { generarXmlComunicacionBaja } from '../src/xml/resumenes.js';
import { RUC_EMPRESA, contextoPrueba, empresaPrueba, boletaFija as solicitudBoleta } from './ayudantes.js';
import { crearPfxPrueba } from './certificado-prueba.js';
import { SunatSimulado } from './sunat-simulado.js';

const cert = leerPfx(crearPfxPrueba(), 'clave-de-prueba');
const credBeta = { usuario: `${RUC_EMPRESA}MODDATOS`, clave: 'MODDATOS' };

function boletaFirmada(): { nombre: string; xml: string } {
  const r = prepararComprobante(solicitudBoleta(), contextoPrueba);
  if (!r.ok) throw new Error(r.errores.join());
  const c = { ...r.comprobante, numero: 1 };
  return { nombre: nombreArchivoComprobante(RUC_EMPRESA, c.tipo, c.serie, c.numero), xml: firmarXml(generarXmlComprobante(c), cert).xmlFirmado };
}

describe('piezas del envío', () => {
  it('ZIP enorme al descomprimirse (bomba ZIP): se rechaza sin abrirlo', () => {
    const bomba = Buffer.from(zipSync({ 'R-cdr.xml': new Uint8Array(6 * 1024 * 1024) }, { level: 9 }));
    expect(bomba.length).toBeLessThan(100_000); // pesa poco comprimido…
    expect(() => extraerXml(bomba)).toThrow(/no contiene ningún XML/); // …y no se abre
  });

  it('ZIP: un solo XML con el nombre de SUNAT, ida y vuelta', () => {
    const zip = comprimirXml('20600000005-03-B001-1', '<a>ñ</a>');
    expect(extraerXml(zip)).toEqual({ nombre: '20600000005-03-B001-1.xml', xml: '<a>ñ</a>' });
    expect(() => extraerXml(Buffer.from('no es zip'))).toThrow(/no es un ZIP válido/);
  });

  it('sobre SOAP con WS-Security y los parámetros sin prefijo, como el WSDL', () => {
    const xml = construirSobre('sendBill', { fileName: 'a.zip', contentFile: 'QUJD' }, { usuario: 'U<&>', clave: 'C' });
    const d = new DOMParser().parseFromString(xml, 'text/xml');
    const op = d.getElementsByTagNameNS('http://service.sunat.gob.pe', 'sendBill')[0]!;
    expect(op).toBeDefined();
    expect(op.getElementsByTagName('fileName')[0]!.namespaceURI).toBeNull();
    const user = d.getElementsByTagNameNS('http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd', 'Username')[0]!;
    expect(user.textContent).toBe('U<&>'); // escapado correctamente
    expect(xml).toContain('#PasswordText');
  });

  it('código de SUNAT desde el SOAP Fault', () => {
    expect(codigoDeFault('soap-env:Client.0102', 'Usuario o contraseña incorrectos')).toBe('0102');
    expect(codigoDeFault('soap-env:Server', '0100 - El sistema no puede responder')).toBe('0100');
    expect(codigoDeFault('soap-env:Client.2335', 'x')).toBe('2335');
    expect(codigoDeFault('env:Server', 'NullPointerException')).toBe('DESCONOCIDO');
  });

  it('rangos de códigos: excepción, rechazo, observación', () => {
    expect(tipoPorRango('0100')).toBe('EXCEPCION');
    expect(tipoPorRango('1033')).toBe('EXCEPCION');
    expect(tipoPorRango('2335')).toBe('RECHAZO');
    expect(tipoPorRango('4252')).toBe('OBSERVACION');
    expect(clasificarRespuesta('0', [])).toBe('ACEPTADO');
    expect(clasificarRespuesta('0', ['4252 - x'])).toBe('ACEPTADO_OBS');
    expect(clasificarRespuesta('4252', [])).toBe('ACEPTADO_OBS');
    expect(clasificarRespuesta('2800', [])).toBe('RECHAZADO');
  });

  it('producción bloqueada sin el doble candado', () => {
    expect(urlServicio('BETA', {})).toBe(URL_BILL_SERVICE.BETA);
    expect(() => urlServicio('PRODUCCION', {})).toThrow(/PRODUCCIÓN bloqueado/);
    expect(urlServicio('PRODUCCION', { SUNAT_PERMITIR_PRODUCCION: 'si' })).toBe(URL_BILL_SERVICE.PRODUCCION);
    // La URL simulada solo se acepta para beta, nunca reemplaza la de producción.
    expect(urlServicio('PRODUCCION', { SUNAT_PERMITIR_PRODUCCION: 'si', SUNAT_URL_BETA: 'http://x' })).toBe(URL_BILL_SERVICE.PRODUCCION);
  });
});

describe('cliente contra SUNAT simulado', () => {
  const sunat = new SunatSimulado();
  let cliente: ClienteSunatSoap;
  beforeAll(async () => {
    await sunat.iniciar();
    cliente = new ClienteSunatSoap({ url: sunat.url, credenciales: credBeta, tiempoMaximoMs: 500 });
  });
  afterAll(() => sunat.detener());
  beforeEach(() => sunat.reiniciar());

  it('aceptado: lee el CDR (ignorando la carpeta dummy del ZIP)', async () => {
    const b = boletaFirmada();
    const cdr = await cliente.sendBill(b.nombre, b.xml);
    expect(cdr.resultado).toBe('ACEPTADO');
    expect(cdr.codigo).toBe('0');
    expect(cdr.referenciaId).toBe('B001-1');
    const recibida = sunat.recibidas[0]!;
    expect(recibida.fileName).toBe('20600000005-03-B001-1.zip');
    expect(recibida.usuario).toBe('20600000005MODDATOS');
    expect(recibida.firmaValida).toBe(true);
    expect(recibida.xml).toBe(b.xml); // llegó exactamente lo firmado
  });

  it('aceptado con observaciones', async () => {
    sunat.colaBill.push({ modo: 'observar', notas: ['4252 - El dato ingresado como atributo @listName es incorrecto.'] });
    const b = boletaFirmada();
    const cdr = await cliente.sendBill(b.nombre, b.xml);
    expect(cdr.resultado).toBe('ACEPTADO_OBS');
    expect(cdr.observaciones).toEqual(['4252 - El dato ingresado como atributo @listName es incorrecto.']);
  });

  it('rechazo dentro del CDR', async () => {
    sunat.colaBill.push({ modo: 'rechazarCdr', codigo: '2800', descripcion: 'Tipo de documento no permitido' });
    const b = boletaFirmada();
    expect((await cliente.sendBill(b.nombre, b.xml)).resultado).toBe('RECHAZADO');
  });

  it('SOAP Fault: error con el código de SUNAT', async () => {
    sunat.colaBill.push({ modo: 'fault', codigo: '0100', mensaje: 'El sistema no puede responder su solicitud' });
    const b = boletaFirmada();
    const e = await cliente.sendBill(b.nombre, b.xml).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorRespuestaSunat);
    expect((e as ErrorRespuestaSunat).codigo).toBe('0100');
  });

  it('XML alterado después de firmar: SUNAT lo rechaza (2335)', async () => {
    const b = boletaFirmada();
    const e = await cliente.sendBill(b.nombre, b.xml.replace('350.00', '1.00')).catch((x: unknown) => x);
    expect((e as ErrorRespuestaSunat).codigo).toBe('2335');
  });

  it('usuario equivocado (0102)', async () => {
    const malo = new ClienteSunatSoap({ url: sunat.url, credenciales: { usuario: '20600000005OTRO', clave: 'x' } });
    const b = boletaFirmada();
    expect(((await malo.sendBill(b.nombre, b.xml).catch((x: unknown) => x)) as ErrorRespuestaSunat).codigo).toBe('0102');
  });

  it.each([['colgar'], ['cortar'], ['http500']] as const)('SUNAT sin respuesta válida (%s): error de conexión reintentable', async (modo) => {
    sunat.colaBill.push({ modo });
    const b = boletaFirmada();
    await expect(cliente.sendBill(b.nombre, b.xml)).rejects.toBeInstanceOf(ErrorConexionSunat);
  });

  it('SUNAT responde una página HTML 401 (falla del servidor beta): mensaje claro y sin ruido en consola', async () => {
    const html = '<html><head><title>401</title></head><body><h1>401 Unauthorized</h1><hr></body></html>';
    const errores: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errores.push(a);
    try {
      const c = new ClienteSunatSoap({ url: 'http://sunat.invalid', credenciales: credBeta, fetch: async () => new Response(html, { status: 401 }) });
      const b = boletaFirmada();
      const e = (await c.sendBill(b.nombre, b.xml).catch((x: unknown) => x)) as ErrorConexionSunat;
      expect(e).toBeInstanceOf(ErrorConexionSunat);
      expect(e.httpEstado).toBe(401);
      expect(e.message).toMatch(/usuario y clave.*se reintenta solo/);
    } finally {
      console.error = original;
    }
    expect(errores).toEqual([]);
  });

  it('servidor apagado: error de conexión', async () => {
    const apagado = new ClienteSunatSoap({ url: 'http://127.0.0.1:1/billService', credenciales: credBeta, tiempoMaximoMs: 500 });
    const b = boletaFirmada();
    await expect(apagado.sendBill(b.nombre, b.xml)).rejects.toThrow('No se pudo conectar con SUNAT.');
  });

  it('resumen: ticket y consulta (en proceso → aceptado)', async () => {
    const ra = generarXmlComunicacionBaja({
      empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-22',
      lineas: [{ tipo: '01', serie: 'F001', numero: 1, motivo: 'Error' }],
    });
    const ticket = await cliente.sendSummary('20600000005-RA-20261022-1', firmarXml(ra, cert).xmlFirmado);
    expect(ticket).toMatch(/^\d+$/);
    sunat.colaStatus.push({ modo: 'procesando' });
    expect((await cliente.getStatus(ticket)).statusCode).toBe('98');
    const listo = await cliente.getStatus(ticket);
    expect(listo.statusCode).toBe('0');
    expect(listo.cdr?.resultado).toBe('ACEPTADO');
  });

  it('CDR inválido', () => {
    expect(() => leerCdr(comprimirXml('R-x', '<a/>'))).toThrow(/no tiene la respuesta/);
  });
});
