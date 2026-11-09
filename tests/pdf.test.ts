/**
 * PDF: se revisa el TEXTO (pdftotext) y se LEE EL QR desde la imagen (pdftoppm + jsQR),
 * como lo haría el celular de un cliente.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQRModulo from 'jsqr';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { prepararComprobante, type SolicitudComprobante } from '../src/comprobantes/preparar.js';
import { Decimal } from '../src/dinero.js';
import { ErrorPdf, contenidoQr, formatearMonto, generarPdf, type DatosPdf, type FormatoPdf } from '../src/pdf/representacion.js';
import { Afectacion, TipoComprobante, type Comprobante } from '../src/tipos.js';
import { TipoDocIdentidad } from '../src/validaciones/documentos.js';
import { contextoPrueba, item, boletaFija as solicitudBoleta, facturaFija as solicitudFactura } from './ayudantes.js';

// La librería exporta la función por defecto; sus tipos no lo reflejan con NodeNext.
const jsQR = jsQRModulo as unknown as (datos: Uint8ClampedArray, ancho: number, alto: number) => { data: string } | null;

function armar(s: SolicitudComprobante, numero = 15, ctx = contextoPrueba): Comprobante {
  const r = prepararComprobante(s, ctx);
  if (!r.ok) throw new Error(r.errores.join());
  return { ...r.comprobante, numero };
}

const datos = (c: Comprobante, extra: Partial<DatosPdf> = {}): DatosPdf => ({
  comprobante: c, hashFirma: 'Hf9DduDMqr/iDCtCWDj+BfAxs4U=', estado: 'ACEPTADO', ambiente: 'PRODUCCION', ...extra,
});

function guardar(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
  const ruta = join(dir, 'c.pdf');
  writeFileSync(ruta, pdf);
  return ruta;
}

function texto(pdf: Buffer): string {
  // -raw: el texto en el orden en que se dibujó (no mezcla columnas e incluye el texto inclinado).
  return execFileSync('pdftotext', ['-raw', guardar(pdf), '-']).toString();
}

function paginas(pdf: Buffer): number {
  return Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [guardar(pdf)]).toString())![1]);
}

/** Convierte la primera página a imagen y lee el QR. */
function leerQr(pdf: Buffer): string | undefined {
  const ruta = guardar(pdf);
  execFileSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', ruta, ruta]);
  const dir = join(ruta, '..');
  const png = PNG.sync.read(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.png'))!)));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
}

describe.each<FormatoPdf>(['A4', 'TICKET_80'])('PDF %s', (formato) => {
  it('factura: datos obligatorios, totales, hash y leyenda', async () => {
    const pdf = await generarPdf(datos(armar(solicitudFactura())), formato);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const t = texto(pdf).replace(/\s+/g, ' ');
    expect(t).toContain('EMPRESA DE PRUEBA S.A.C.');
    expect(t).toContain('R.U.C. 20600000005');
    expect(t).toContain('FACTURA ELECTRÓNICA');
    expect(t).toContain('F001-00000015');
    expect(t).toContain('20/10/2026');
    expect(t).toContain('20600000013');
    expect(t).toContain('CLIENTE EMPRESA S.A.C.');
    expect(t).toContain('Almohada & funda "premium"');
    expect(t).toMatch(/Op\. gravadas\s+1,101\.53/);
    expect(t).toMatch(/IGV \(18%\)\s+198\.27/);
    expect(t).toMatch(/IMPORTE TOTAL S\/\s+1,299\.80/);
    expect(t).toContain('SON MIL DOSCIENTOS NOVENTA Y NUEVE CON 80/100 SOLES');
    expect(t).toContain('Código hash: Hf9DduDMqr/iDCtCWDj+BfAxs4U=');
    expect(t).toContain('Representación impresa de la FACTURA ELECTRÓNICA');
    expect(t).not.toContain('SIN VALOR LEGAL');
  });

  it('el QR se puede leer y contiene los datos de SUNAT', async () => {
    const c = armar(solicitudFactura());
    const qr = leerQr(await generarPdf(datos(c), formato));
    expect(qr).toBe('20600000005|01|F001|15|198.27|1299.80|2026-10-20|6|20600000013|');
    expect(qr).toBe(contenidoQr(c));
  });

  it('con descuento global: muestra el descuento y el total ya rebajado', async () => {
    const c = armar(solicitudBoleta({ items: [item('354.00', '2')], descuentoGlobal: '50.00' }), 8);
    const t = texto(await generarPdf(datos(c), formato)).replace(/\s+/g, ' ');
    expect(t).toContain('Descuento global (sin IGV)');
    expect(t).toContain('-42.37');
    expect(t).toContain('658.00');
  });

  it('boleta sin cliente identificado', async () => {
    const c = armar(solicitudBoleta({ serie: 'B001', cliente: { tipoDoc: TipoDocIdentidad.SIN_DOCUMENTO, numeroDoc: '-', nombre: 'CLIENTES VARIOS' } }), 7);
    const t = texto(await generarPdf(datos(c), formato)).replace(/\s+/g, ' ');
    expect(t).toContain('BOLETA DE VENTA ELECTRÓNICA');
    expect(t).toContain('B001-00000007');
    expect(t).toContain('CLIENTES VARIOS');
    expect(t).not.toContain('Forma de pago'); // solo en facturas
  });

  it('nota de crédito: documento que modifica y motivo', async () => {
    const c = armar(solicitudFactura({
      tipo: TipoComprobante.NOTA_CREDITO, serie: 'FC01', items: [item('59.90')],
      notaCredito: { referencia: { tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 15 }, motivoCodigo: '07', motivoDescripcion: 'Devolución de una almohada' },
    }), 3);
    const t = texto(await generarPdf(datos(c), formato)).replace(/\s+/g, ' ');
    expect(t).toContain('NOTA DE CRÉDITO ELECTRÓNICA');
    expect(t).toContain('FC01-00000003');
    expect(t).toContain('FACTURA ELECTRÓNICA F001-00000015');
    expect(t).toContain('07 - Devolución por ítem');
    expect(t).toContain('Devolución de una almohada');
  });

  it('nota de débito: título, documento que modifica y motivo del catálogo 10', async () => {
    const c = armar(solicitudFactura({
      tipo: TipoComprobante.NOTA_DEBITO, serie: 'FD01', items: [item('59.00', '1', { descripcion: 'Flete a Arequipa' })],
      notaDebito: { referencia: { tipo: TipoComprobante.FACTURA, serie: 'F001', numero: 15 }, motivoCodigo: '02', motivoDescripcion: 'Flete acordado después de la venta' },
    }), 1);
    const t = texto(await generarPdf(datos(c), formato)).replace(/\s+/g, ' ');
    expect(t).toContain('NOTA DE DÉBITO ELECTRÓNICA');
    expect(t).toContain('FD01-00000001');
    expect(t).toContain('FACTURA ELECTRÓNICA F001-00000015');
    expect(t).toContain('02 - Aumento en el valor');
    expect(t).toContain('Flete acordado después de la venta');
  });

  it('factura al crédito: muestra las cuotas', async () => {
    const c = armar(solicitudFactura({
      items: [item('1000.00')],
      formaPago: { tipo: 'CREDITO', cuotas: [{ monto: '600', fechaVencimiento: '2026-11-20' }, { monto: '400', fechaVencimiento: '2026-12-20' }] },
    }));
    const t = texto(await generarPdf(datos(c), formato)).replace(/\s+/g, ' ');
    expect(t).toContain('CRÉDITO');
    expect(t).toMatch(/Cuota 001.*20\/11\/2026.*600\.00/);
    expect(t).toMatch(/Cuota 002.*20\/12\/2026.*400\.00/);
  });

  it('boleta exonerada (taxi): sin IGV y con operaciones exoneradas', async () => {
    const ctx = { ...contextoPrueba, afectacionesPermitidas: [Afectacion.GRAVADO, Afectacion.EXONERADO] };
    const c = armar(solicitudBoleta({ items: [item('25.00', '1', { descripcion: 'Servicio de taxi', unidad: 'ZZ', afectacion: Afectacion.EXONERADO })] }), 1, ctx);
    const t = texto(await generarPdf(datos(c), formato)).replace(/\s+/g, ' ');
    expect(t).toMatch(/Op\. exoneradas\s+25\.00/);
    expect(t).toMatch(/IGV\s+0\.00/);
    expect(t).not.toContain('Op. gravadas');
    expect(t).toContain('SERV');
  });

  it('ambiente BETA: marca "PRUEBA - SIN VALOR LEGAL"; anulado: marca "ANULADO"', async () => {
    const c = armar(solicitudBoleta());
    expect(texto(await generarPdf(datos(c, { ambiente: 'BETA' }), formato))).toMatch(/SIN VALOR\s*LEGAL/);
    expect(texto(await generarPdf(datos(c, { estado: 'ANULADO' }), formato))).toContain('ANULADO');
  });

  it('no imprime rechazados ni comprobantes sin firmar', async () => {
    const c = armar(solicitudBoleta());
    await expect(generarPdf(datos(c, { estado: 'RECHAZADO' }), formato)).rejects.toThrow(ErrorPdf);
    await expect(generarPdf(datos(c, { hashFirma: '' }), formato)).rejects.toThrow(/no está firmado/);
  });

  it('logo inválido: imprime igual, sin logo', async () => {
    const pdf = await generarPdf(datos(armar(solicitudBoleta()), { logo: Buffer.from('no es imagen') }), formato);
    expect(texto(pdf)).toContain('BOLETA DE VENTA ELECTRÓNICA');
  });
});

describe('PDF: detalles', () => {
  it('A4 con muchos ítems pasa a una segunda página y repite el encabezado de la tabla', async () => {
    const items = Array.from({ length: 45 }, (_, i) => item('10.00', '1', { codigo: `P${i}`, descripcion: `Producto número ${i + 1} con descripción larga para ocupar más de una línea en la tabla` }));
    const pdf = await generarPdf(datos(armar(solicitudBoleta({ items }))), 'A4');
    expect(paginas(pdf)).toBeGreaterThan(1);
    const t = texto(pdf);
    expect(t.match(/DESCRIPCIÓN/g)!.length).toBeGreaterThan(1);
    expect(t).toContain('Producto número 45');
    expect(t.replace(/\s+/g, ' ')).toMatch(/IMPORTE TOTAL S\/ 450\.00/);
  });

  it('el ticket es una sola tira con el alto justo', async () => {
    const corto = await generarPdf(datos(armar(solicitudBoleta())), 'TICKET_80');
    const items = Array.from({ length: 20 }, (_, i) => item('10.00', '1', { descripcion: `Producto ${i}` }));
    const largo = await generarPdf(datos(armar(solicitudBoleta({ items }))), 'TICKET_80');
    expect(paginas(corto)).toBe(1);
    expect(paginas(largo)).toBe(1);
    const alto = (pdf: Buffer) => Number(/Page size:\s+[\d.]+ x ([\d.]+)/.exec(execFileSync('pdfinfo', [guardar(pdf)]).toString())![1]);
    expect(alto(largo)).toBeGreaterThan(alto(corto));
    expect(Number(/Page size:\s+([\d.]+)/.exec(execFileSync('pdfinfo', [guardar(corto)]).toString())![1])).toBeCloseTo(226.77, 1);
  });

  it('formato de montos con separador de miles, sin usar number', () => {
    expect(formatearMonto(new Decimal('1299.8'))).toBe('1,299.80');
    expect(formatearMonto(new Decimal('1234567.005'))).toBe('1,234,567.01');
    expect(formatearMonto(new Decimal('5'))).toBe('5.00');
  });
});
