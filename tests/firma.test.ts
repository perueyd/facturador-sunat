import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepararComprobante, type SolicitudComprobante } from '../src/comprobantes/preparar.js';
import { CondicionResumen } from '../src/catalogos.js';
import { ErrorCertificado, diasParaVencer, leerPfx, verificarVigencia } from '../src/firma/certificado.js';
import { algoritmoDesdeEntorno, firmarXml, verificarFirma, type AlgoritmoFirma } from '../src/firma/firmar.js';
import { cifrar, descifrar, generarLlaveMaestra, llaveMaestraDesdeEntorno } from '../src/seguridad/cifrado.js';
import { TipoComprobante, type Comprobante } from '../src/tipos.js';
import { generarXmlComprobante } from '../src/xml/comprobante.js';
import { generarXmlComunicacionBaja, generarXmlResumenDiario } from '../src/xml/resumenes.js';
import { contextoPrueba, empresaPrueba, item, boletaFija as solicitudBoleta, facturaFija as solicitudFactura, validarContraXsd } from './ayudantes.js';
import { crearPfxPrueba } from './certificado-prueba.js';

const VERIFICADOR = fileURLToPath(new URL('./verificador_independiente.py', import.meta.url));

function verificarIndependiente(xml: string): string {
  try {
    return execFileSync('python3', ['-I', VERIFICADOR], { input: xml, stdio: 'pipe' }).toString().trim();
  } catch (e) {
    return (e as { stdout?: Buffer }).stdout?.toString().trim() ?? 'ERROR desconocido';
  }
}

function armar(s: SolicitudComprobante, numero = 1): Comprobante {
  const r = prepararComprobante(s, contextoPrueba);
  if (!r.ok) throw new Error(r.errores.join('\n'));
  return { ...r.comprobante, numero };
}

const cert = leerPfx(crearPfxPrueba(), 'clave-de-prueba');

describe('certificado .pfx', () => {
  it('lee llave, certificado y datos', () => {
    expect(cert.llavePrivadaPem).toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(cert.certificadoPem).toMatch(/BEGIN CERTIFICATE/);
    expect(cert.sujeto).toContain('PRUEBA 20600000005');
    expect(cert.huella).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(diasParaVencer(cert)).toBeGreaterThan(360);
  });

  it('contraseña equivocada: mensaje claro', () => {
    expect(() => leerPfx(crearPfxPrueba(), 'otra')).toThrow('La contraseña del certificado .pfx no es correcta.');
  });

  it('archivo que no es .pfx', () => {
    expect(() => leerPfx(Buffer.from('hola'), 'x')).toThrow(ErrorCertificado);
  });

  it('con cadena de certificados elige el que corresponde a la llave', () => {
    const c = leerPfx(crearPfxPrueba({ conCadena: true }), 'clave-de-prueba');
    expect(c.sujeto).toContain('PRUEBA');
    expect(c.sujeto).not.toContain('CA DE PRUEBA');
  });

  it('vencido o aún no vigente: no se firma', () => {
    const vencido = leerPfx(crearPfxPrueba({ desde: new Date('2020-01-01'), hasta: new Date('2021-01-01') }), 'clave-de-prueba');
    expect(() => verificarVigencia(vencido)).toThrow(/venció el 2021-01-01/);
    const futuro = leerPfx(crearPfxPrueba({ desde: new Date('2099-01-01'), hasta: new Date('2100-01-01') }), 'clave-de-prueba');
    expect(() => verificarVigencia(futuro)).toThrow(/recién es válido desde/);
    expect(() => verificarVigencia(cert)).not.toThrow();
  });
});

describe.each<AlgoritmoFirma>(['SHA1', 'SHA256'])('firma %s', (algoritmo) => {
  const xml = generarXmlComprobante(armar(solicitudFactura(), 15));
  const r = firmarXml(xml, cert, algoritmo);

  it('la firma queda dentro de ext:ExtensionContent con Id SignatureSP', () => {
    expect(r.xmlFirmado).toMatch(/<ext:ExtensionContent><ds:Signature [^>]*Id="SignatureSP"/);
    expect(r.xmlFirmado).toContain('<ds:X509Certificate>');
    expect(r.xmlFirmado).toContain(cert.certificadoBase64.slice(0, 40));
    expect(r.digestValue).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('verifica con nuestra librería y con el verificador independiente', () => {
    expect(verificarFirma(r.xmlFirmado, cert.certificadoPem)).toEqual({ valida: true, errores: [] });
    expect(verificarIndependiente(r.xmlFirmado)).toBe(`OK rsa-${algoritmo.toLowerCase()}`);
  });

  it('el XML firmado sigue cumpliendo el esquema UBL 2.1 (ahora con la firma real)', () => {
    expect(() => validarContraXsd(r.xmlFirmado, 'UBL-Invoice-2.1.xsd')).not.toThrow();
  });

  it('si alguien cambia un monto después de firmar, la firma ya no vale', () => {
    const alterado = r.xmlFirmado.replace('<cbc:PayableAmount currencyID="PEN">1299.80<', '<cbc:PayableAmount currencyID="PEN">1.00<');
    expect(alterado).not.toBe(r.xmlFirmado);
    expect(verificarFirma(alterado, cert.certificadoPem).valida).toBe(false);
    expect(verificarIndependiente(alterado)).toMatch(/^ERROR el DigestValue no coincide/);
  });

  it('una firma de otro certificado no pasa como nuestra', () => {
    const otro = leerPfx(crearPfxPrueba({ ruc: '20100170338' }), 'clave-de-prueba');
    const ajena = firmarXml(xml, otro, algoritmo);
    expect(verificarFirma(ajena.xmlFirmado).valida).toBe(true); // íntegra…
    expect(verificarFirma(ajena.xmlFirmado, cert.certificadoPem).valida).toBe(false); // …pero no es nuestra
  });

  it('cambiar el certificado incluido en la firma la invalida', () => {
    const otro = leerPfx(crearPfxPrueba({ ruc: '20100170338' }), 'clave-de-prueba');
    const cambiado = r.xmlFirmado.replace(cert.certificadoBase64, otro.certificadoBase64);
    expect(cambiado).not.toBe(r.xmlFirmado);
    expect(verificarIndependiente(cambiado)).toBe('ERROR la firma RSA no es válida');
  });
});

describe('firma de los demás documentos', () => {
  it('boleta y nota de crédito', () => {
    const boleta = firmarXml(generarXmlComprobante(armar(solicitudBoleta())), cert);
    expect(verificarIndependiente(boleta.xmlFirmado)).toBe('OK rsa-sha1');
    expect(() => validarContraXsd(boleta.xmlFirmado, 'UBL-Invoice-2.1.xsd')).not.toThrow();

    const nc = armar(
      solicitudBoleta({
        tipo: TipoComprobante.NOTA_CREDITO,
        serie: 'BC01',
        items: [item('100.00')],
        notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo: '06', motivoDescripcion: 'Devolución total' },
      }),
    );
    const ncFirmada = firmarXml(generarXmlComprobante(nc), cert);
    expect(verificarIndependiente(ncFirmada.xmlFirmado)).toBe('OK rsa-sha1');
    expect(() => validarContraXsd(ncFirmada.xmlFirmado, 'UBL-CreditNote-2.1.xsd')).not.toThrow();
  });

  it('resumen diario y comunicación de baja', () => {
    const rc = generarXmlResumenDiario({
      empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-21',
      lineas: [{ comprobante: armar(solicitudBoleta()), condicion: CondicionResumen.ADICIONAR }],
    });
    const ra = generarXmlComunicacionBaja({
      empresa: empresaPrueba, correlativo: 1, fechaReferencia: '2026-10-20', fechaGeneracion: '2026-10-22',
      lineas: [{ tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 1, motivo: 'Error' }],
    });
    expect(verificarIndependiente(firmarXml(rc, cert).xmlFirmado)).toBe('OK rsa-sha1');
    expect(verificarIndependiente(firmarXml(ra, cert).xmlFirmado)).toBe('OK rsa-sha1');
  });

  it('caracteres especiales y tildes no rompen la firma', () => {
    const s = solicitudFactura({ items: [item('10.00', '1', { descripcion: 'Cabecera "Ñandú" & más <grande>' })] });
    const r = firmarXml(generarXmlComprobante(armar(s)), cert);
    expect(verificarIndependiente(r.xmlFirmado)).toBe('OK rsa-sha1');
  });

  it('no firma dos veces el mismo XML', () => {
    const r = firmarXml(generarXmlComprobante(armar(solicitudBoleta())), cert);
    expect(() => firmarXml(r.xmlFirmado, cert)).toThrow(/ya está firmado/);
  });

  it('la firma es reproducible: mismo XML y certificado → mismo resultado', () => {
    const xml = generarXmlComprobante(armar(solicitudBoleta()));
    expect(firmarXml(xml, cert).xmlFirmado).toBe(firmarXml(xml, cert).xmlFirmado);
  });

  it('algoritmo configurable desde el entorno', () => {
    expect(algoritmoDesdeEntorno(undefined)).toBe('SHA1');
    expect(algoritmoDesdeEntorno('SHA256')).toBe('SHA256');
    expect(() => algoritmoDesdeEntorno('MD5')).toThrow();
  });
});

describe('cifrado de datos sensibles', () => {
  const llave = Buffer.from(generarLlaveMaestra(), 'base64');

  it('cifra y descifra', () => {
    const datos = Buffer.from('secreto ñ');
    const c = cifrar(datos, llave, 'certificado:empresa-1');
    expect(c.includes(datos)).toBe(false);
    expect(descifrar(c, llave, 'certificado:empresa-1').toString()).toBe('secreto ñ');
  });

  it('cada cifrado es distinto aunque el dato sea el mismo', () => {
    const d = Buffer.from('x');
    expect(cifrar(d, llave, 'a').equals(cifrar(d, llave, 'a'))).toBe(false);
  });

  it('otra llave, otro contexto (otra empresa) o un dato alterado: no se descifra', () => {
    const c = cifrar(Buffer.from('secreto'), llave, 'certificado:empresa-1');
    const otraLlave = Buffer.from(generarLlaveMaestra(), 'base64');
    expect(() => descifrar(c, otraLlave, 'certificado:empresa-1')).toThrow(/no se pudo descifrar/i);
    expect(() => descifrar(c, llave, 'certificado:empresa-2')).toThrow(/no se pudo descifrar/i);
    const alterado = Buffer.from(c);
    alterado[alterado.length - 1]! ^= 1;
    expect(() => descifrar(alterado, llave, 'certificado:empresa-1')).toThrow(/no se pudo descifrar/i);
  });

  it('la llave maestra debe existir y tener 32 bytes', () => {
    expect(() => llaveMaestraDesdeEntorno('')).toThrow(/Falta/);
    expect(() => llaveMaestraDesdeEntorno(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(llaveMaestraDesdeEntorno(generarLlaveMaestra()).length).toBe(32);
  });
});
