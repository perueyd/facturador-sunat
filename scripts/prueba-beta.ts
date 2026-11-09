/**
 * PRUEBA REAL contra SUNAT BETA (no tiene validez legal; no usa la base de datos).
 *
 * Uso:   npm run sunat:beta -- --ruc 20XXXXXXXXX
 *
 * - Usuario público de pruebas de SUNAT: RUC + MODDATOS / MODDATOS (no usa tu Clave SOL).
 * - Firma con un certificado de PRUEBA generado al momento (beta no exige uno registrado).
 * - Envía: boleta con DNI, boleta sin cliente identificado, factura, factura al crédito,
 *   nota de crédito y una comunicación de baja; con firma SHA1 y SHA256.
 * - Guarda lo enviado y lo recibido en ./resultados-beta/ (no se sube a GitHub).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { prepararComprobante, type SolicitudComprobante } from '../src/comprobantes/preparar.js';
import { Decimal } from '../src/dinero.js';
import { ahoraLima } from '../src/fechas.js';
import { leerPfx } from '../src/firma/certificado.js';
import { firmarXml, type AlgoritmoFirma } from '../src/firma/firmar.js';
import { ClienteSunatSoap, ErrorConexionSunat, ErrorRespuestaSunat } from '../src/sunat/cliente.js';
import { URL_BILL_SERVICE } from '../src/sunat/configuracion.js';
import { tipoPorRango } from '../src/sunat/errores.js';
import { Afectacion, TipoComprobante, type Comprobante, type Empresa } from '../src/tipos.js';
import { TipoDocIdentidad, esRucValido } from '../src/validaciones/documentos.js';
import { generarXmlComprobante } from '../src/xml/comprobante.js';
import { nombreArchivoComprobante, nombreArchivoResumen } from '../src/xml/nombres.js';
import { generarXmlComunicacionBaja, idResumen } from '../src/xml/resumenes.js';
import { crearPfxPrueba } from '../tests/certificado-prueba.js';

const { values } = parseArgs({ options: { ruc: { type: 'string' }, url: { type: 'string' } } });
const ruc = values.ruc ?? '';
if (!esRucValido(ruc)) {
  console.error('Uso: npm run sunat:beta -- --ruc 20XXXXXXXXX   (un RUC válido; usa el de tu empresa)');
  process.exit(1);
}
const url = values.url ?? URL_BILL_SERVICE.BETA;
if (url.includes('e-factura.sunat.gob.pe')) {
  console.error('Este comando es SOLO para beta.');
  process.exit(1);
}

const { fecha, hora } = ahoraLima();
const empresa: Empresa = {
  ruc,
  razonSocial: 'EMPRESA DE PRUEBA BETA S.A.C.',
  regimen: 'MYPE_TRIBUTARIO',
  direccion: { ubigeo: '150101', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA', direccion: 'AV. PRUEBA 123', codigoLocal: '0000' },
};
const ctx = {
  empresa,
  parametros: { igvTasa: new Decimal('0.18'), montoBoletaIdentificar: new Decimal('700') },
  comprobantesPermitidos: [TipoComprobante.FACTURA, TipoComprobante.BOLETA, TipoComprobante.NOTA_CREDITO, TipoComprobante.NOTA_DEBITO],
  afectacionesPermitidas: [Afectacion.GRAVADO, Afectacion.EXONERADO],
};
const item = (descripcion: string, precio: string, cantidad = '1') => ({ codigo: 'P001', descripcion, unidad: 'NIU', cantidad, precioUnitarioConIgv: precio, afectacion: Afectacion.GRAVADO });
// Números distintos en cada corrida para no repetir comprobantes ya enviados.
const base = Math.floor(Date.now() / 1000) % 9_000_000 + 1_000_000;
const en30dias = new Date(Date.parse(`${fecha}T12:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
const comun = { fechaEmision: fecha, horaEmision: hora, formaPago: { tipo: 'CONTADO' as const } };

const casos: { nombre: string; s: SolicitudComprobante; numero: number }[] = [
  { nombre: 'Boleta con DNI', numero: base, s: { ...comun, tipo: '03', serie: 'B001', cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '12345678', nombre: 'CLIENTE DE PRUEBA' }, items: [item('Tarima 2 plazas', '350.00')] } },
  { nombre: 'Boleta sin cliente (tipo 0)', numero: base + 1, s: { ...comun, tipo: '03', serie: 'B001', cliente: { tipoDoc: TipoDocIdentidad.SIN_DOCUMENTO, numeroDoc: '-', nombre: 'CLIENTES VARIOS' }, items: [item('Almohada', '59.90', '2')] } },
  { nombre: 'Factura al contado', numero: base, s: { ...comun, tipo: '01', serie: 'F001', cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: '20100070970', nombre: 'CLIENTE EMPRESA S.A.C.' }, items: [item('Cabecera melamina', '1180.00'), item('Colchón', '899.90')] } },
  { nombre: 'Factura al crédito (2 cuotas)', numero: base + 1, s: { ...comun, tipo: '01', serie: 'F001', formaPago: { tipo: 'CREDITO', cuotas: [{ monto: '600.00', fechaVencimiento: en30dias }, { monto: '580.00', fechaVencimiento: en30dias }] }, cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: '20100070970', nombre: 'CLIENTE EMPRESA S.A.C.' }, items: [item('Cabecera melamina', '1180.00')] } },
  // Descuento global (catálogo 53, código 02), como los cupones y ofertas de la tienda.
  { nombre: 'Boleta con descuento (cupón)', numero: base + 2, s: { ...comun, tipo: '03', serie: 'B001', descuentoGlobal: '50.00', cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '12345678', nombre: 'CLIENTE DE PRUEBA' }, items: [item('Tarima 2 plazas', '354.00', '2')] } },
  { nombre: 'Factura con descuento', numero: base + 2, s: { ...comun, tipo: '01', serie: 'F001', descuentoGlobal: '100.00', cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: '20100070970', nombre: 'CLIENTE EMPRESA S.A.C.' }, items: [item('Cabecera melamina', '1180.00'), item('Colchón', '899.90')] } },
  {
    nombre: 'Nota de crédito de factura', numero: base,
    s: { ...comun, tipo: '07', serie: 'FC01', cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: '20100070970', nombre: 'CLIENTE EMPRESA S.A.C.' }, items: [item('Colchón devuelto', '899.90')], notaCredito: { referencia: { tipo: '01', serie: 'F001', numero: base }, motivoCodigo: '07', motivoDescripcion: 'Devolución de un producto' } },
  },
  // Nota de débito (08): catálogo 10 del Anexo 8 (R.S. 245-2017/SUNAT). Un cargo es un servicio (ZZ).
  {
    nombre: 'Nota de débito de factura', numero: base,
    s: { ...comun, tipo: '08', serie: 'FD01', cliente: { tipoDoc: TipoDocIdentidad.RUC, numeroDoc: '20100070970', nombre: 'CLIENTE EMPRESA S.A.C.' }, items: [{ ...item('Flete a provincia', '118.00'), unidad: 'ZZ' }], notaDebito: { referencia: { tipo: '01', serie: 'F001', numero: base + 1 }, motivoCodigo: '02', motivoDescripcion: 'Aumento en el valor: flete' } },
  },
  {
    nombre: 'Nota de débito de boleta', numero: base,
    s: { ...comun, tipo: '08', serie: 'BD01', cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '12345678', nombre: 'CLIENTE DE PRUEBA' }, items: [{ ...item('Interés por pago tardío', '5.00'), unidad: 'ZZ' }], notaDebito: { referencia: { tipo: '03', serie: 'B001', numero: base }, motivoCodigo: '01', motivoDescripcion: 'Intereses por mora' } },
  },
];

const salida = `resultados-beta/${fecha}-${base}`;
await mkdir(salida, { recursive: true });
const cert = leerPfx(crearPfxPrueba({ ruc }), 'clave-de-prueba');
const cliente = new ClienteSunatSoap({ url, credenciales: { usuario: `${ruc}MODDATOS`, clave: 'MODDATOS' }, tiempoMaximoMs: 60_000 });

interface Fila { caso: string; algoritmo: string; resultado: string; detalle: string }
const filas: Fila[] = [];

async function enviar(caso: string, algoritmo: AlgoritmoFirma, c: Comprobante): Promise<void> {
  const nombre = nombreArchivoComprobante(ruc, c.tipo, c.serie, c.numero);
  const firmado = firmarXml(generarXmlComprobante(c), cert, algoritmo).xmlFirmado;
  await writeFile(`${salida}/${nombre}-${algoritmo}.xml`, firmado);
  try {
    const cdr = await cliente.sendBill(nombre, firmado);
    await writeFile(`${salida}/R-${nombre}-${algoritmo}.zip`, cdr.zip);
    filas.push({ caso, algoritmo, resultado: cdr.resultado, detalle: `${cdr.codigo} ${cdr.descripcion}${cdr.observaciones.length ? ` | Obs: ${cdr.observaciones.join(' | ')}` : ''}` });
  } catch (e) {
    if (e instanceof ErrorRespuestaSunat) filas.push({ caso, algoritmo, resultado: tipoPorRango(e.codigo), detalle: `${e.codigo} ${e.mensajeSunat}` });
    else if (e instanceof ErrorConexionSunat) filas.push({ caso, algoritmo, resultado: e.httpEstado ? `FALLA SUNAT (${e.httpEstado})` : 'SIN CONEXIÓN', detalle: e.message });
    else throw e;
  }
}

console.log(`Enviando a SUNAT BETA (${url}) como ${ruc}MODDATOS…\n`);
for (const algoritmo of ['SHA1', 'SHA256'] as const) {
  for (const caso of casos) {
    const r = prepararComprobante(caso.s, ctx);
    if (!r.ok) {
      filas.push({ caso: caso.nombre, algoritmo, resultado: 'NO VALIDÓ', detalle: r.errores.join(' ') });
      continue;
    }
    // SHA256 usa otros números para no repetir los enviados con SHA1.
    await enviar(caso.nombre, algoritmo, { ...r.comprobante, numero: caso.numero + (algoritmo === 'SHA256' ? 10 : 0) });
  }
}

// Comunicación de baja (resumen asíncrono con ticket).
const ra = generarXmlComunicacionBaja({ empresa, correlativo: (base % 90000) + 1, fechaReferencia: fecha, fechaGeneracion: fecha, lineas: [{ tipo: '01', serie: 'F001', numero: base, motivo: 'Prueba de baja en beta' }] });
const nombreRa = nombreArchivoResumen(ruc, idResumen('RA', fecha, (base % 90000) + 1));
try {
  const firmado = firmarXml(ra, cert, 'SHA1').xmlFirmado;
  await writeFile(`${salida}/${nombreRa}.xml`, firmado);
  const ticket = await cliente.sendSummary(nombreRa, firmado);
  let estado = await cliente.getStatus(ticket);
  for (let i = 0; i < 10 && estado.statusCode === '98'; i++) {
    await new Promise((ok) => setTimeout(ok, 3000));
    estado = await cliente.getStatus(ticket);
  }
  filas.push({ caso: 'Comunicación de baja', algoritmo: 'SHA1', resultado: estado.cdr?.resultado ?? `estado ${estado.statusCode}`, detalle: `ticket ${ticket}: ${estado.cdr ? `${estado.cdr.codigo} ${estado.cdr.descripcion}` : 'sin constancia'}` });
} catch (e) {
  filas.push({ caso: 'Comunicación de baja', algoritmo: 'SHA1', resultado: e instanceof ErrorRespuestaSunat ? tipoPorRango(e.codigo) : 'ERROR', detalle: e instanceof ErrorRespuestaSunat ? `${e.codigo} ${e.mensajeSunat}` : String(e) });
}

console.table(filas);
await writeFile(`${salida}/resumen.json`, JSON.stringify(filas, null, 2));
console.log(`\nArchivos enviados y constancias guardados en ${salida}/`);
console.log('Copia la tabla de arriba y envíamela (no contiene datos sensibles).');
