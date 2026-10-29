/**
 * Cotizaciones: numeración propia sin saltos, importes exactos, validaciones en español, que
 * lo cotizado no se pueda cambiar ni borrar, y que al venderse quede enlazada a la boleta.
 * El PDF debe decir que NO es comprobante de pago.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { leerTokenCotizacion, leerToken, tokenCotizacion } from '../../src/api/enlaces.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import {
  anularCotizacion, cargarCotizacion, crearCotizacion, listarCotizaciones, marcarConvertida, pdfCotizacion, type EntradaCotizacion,
} from '../../src/cotizaciones/cotizaciones.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { item, solicitudBoleta } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe('enlaces de cotización', () => {
  it('un enlace de cotización no abre un comprobante (cada uno con su clave)', () => {
    const llave = Buffer.alloc(32, 7);
    const id = '11111111-2222-3333-4444-555555555555';
    const t = tokenCotizacion(llave, id);
    expect(leerTokenCotizacion(llave, t)).toBe(id);
    expect(leerToken(llave, t)).toBeUndefined();
  });
});

describe.skipIf(!URL_PRUEBAS)('cotizaciones', () => {
  let db: Db;
  let f: Fixture;
  let usuarioId: string;
  const hoy = ahoraLima().fecha;
  const base: EntradaCotizacion = {
    cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: 'JUAN PÉREZ' },
    items: [{ descripcion: 'Cabecera Milán 2 plazas', cantidad: '2', precio: '450.00' }, { descripcion: 'Tarima', cantidad: '1.5', precio: '99.99' }],
    diasValidez: 7,
    nota: 'Entrega en 10 días hábiles.',
  };

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    usuarioId = (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ('cotiza@prueba.pe', 'Cotiza') RETURNING id`)).rows[0].id;
  });

  it('numera COT-000001, COT-000002… y calcula importes exactos', async () => {
    const a = await crearCotizacion(db, f.empresaId, base, usuarioId, hoy);
    expect(a).toMatchObject({ numero: 'COT-000001', fecha: hoy, estado: 'VIGENTE', total: '1049.99', comprobante: null });
    // 1.5 × 99.99 = 149.985 → 149.99 (redondeo a 2 decimales).
    expect(a.items.map((x) => x.importe)).toEqual(['900.00', '149.99']);
    expect(a.items[1]).toMatchObject({ cantidad: '1.5', precio: '99.99' });
    const b = await crearCotizacion(db, f.empresaId, { ...base, cliente: { tipoDocumento: 'NINGUNO', numero: 'x', nombre: '' } }, usuarioId, hoy);
    expect(b.numero).toBe('COT-000002');
    expect(b.cliente).toEqual({ tipoDocumento: 'NINGUNO', numero: '', nombre: '' });
    expect((await listarCotizaciones(db, f.empresaId)).map((x) => x.numero)).toEqual(['COT-000002', 'COT-000001']);
  });

  it('rechaza datos inválidos con mensajes claros', async () => {
    await expect(crearCotizacion(db, f.empresaId, { ...base, cliente: { tipoDocumento: 'RUC', numero: '20600000014', nombre: 'X' } }, usuarioId, hoy)).rejects.toThrow(/RUC no es válido/);
    await expect(crearCotizacion(db, f.empresaId, { ...base, items: [] }, usuarioId, hoy)).rejects.toThrow(/al menos un producto/);
    await expect(crearCotizacion(db, f.empresaId, { ...base, items: [{ descripcion: 'X', cantidad: '0', precio: '1,5' }] }, usuarioId, hoy)).rejects.toThrow(/cantidad inválida.*precio inválido/);
    await expect(crearCotizacion(db, f.empresaId, { ...base, diasValidez: 120 }, usuarioId, hoy)).rejects.toThrow(/1 a 90 días/);
  });

  it('lo cotizado no se cambia ni se borra; se anula una sola vez', async () => {
    const k = await crearCotizacion(db, f.empresaId, base, usuarioId, hoy);
    await expect(db.query(`UPDATE cotizaciones SET total = 1 WHERE id = $1`, [k.id])).rejects.toThrow(/no se modifica/);
    await expect(db.query(`DELETE FROM cotizaciones WHERE id = $1`, [k.id])).rejects.toThrow(/no se borra/);
    await expect(db.query(`UPDATE cotizacion_items SET precio = 1 WHERE cotizacion_id = $1`, [k.id])).rejects.toThrow();
    expect(await anularCotizacion(db, f.empresaId, k.id, usuarioId)).toBe(true);
    expect(await anularCotizacion(db, f.empresaId, k.id, usuarioId)).toBe(false);
    expect((await cargarCotizacion(db, f.empresaId, k.id))?.estado).toBe('ANULADA');
  });

  it('al vender queda enlazada a la boleta; no se enlaza a comprobantes de otra empresa', async () => {
    const k = await crearCotizacion(db, f.empresaId, base, usuarioId, hoy);
    const otra = await crearEmpresa(db, `2060000009${digitoVerificadorRuc('2060000009')}`);
    const ajena = await emitirComprobante(db, { empresaId: otra.empresaId, canalId: otra.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item('10.00')] }) });
    if (ajena.resultado === 'ERROR_VALIDACION') throw new Error(ajena.errores.join('; '));
    expect(await marcarConvertida(db, f.empresaId, k.id, ajena.guardado.id, usuarioId)).toBe(false);

    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item('1049.99')] }) });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('; '));
    expect(await marcarConvertida(db, f.empresaId, k.id, r.guardado.id, usuarioId)).toBe(true);
    const convertida = await cargarCotizacion(db, f.empresaId, k.id);
    expect(convertida).toMatchObject({ estado: 'CONVERTIDA' });
    expect(convertida?.comprobante).toMatch(/^B001-\d{8}$/);
    // Ya convertida: no se anula.
    expect(await anularCotizacion(db, f.empresaId, k.id, usuarioId)).toBe(false);
  });

  it('el PDF dice que NO es comprobante de pago', async () => {
    const k = await crearCotizacion(db, f.empresaId, base, usuarioId, hoy);
    const pdf = await pdfCotizacion(db, f.empresaId, k);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const carpeta = mkdtempSync(join(tmpdir(), 'cot-'));
    writeFileSync(join(carpeta, 'c.pdf'), pdf);
    const texto = execFileSync('pdftotext', [join(carpeta, 'c.pdf'), '-']).toString();
    expect(texto).toContain('COTIZACIÓN');
    expect(texto).toContain(k.numero);
    expect(texto).toContain('NO ES COMPROBANTE DE PAGO');
    expect(texto).toContain('1,049.99');
  });
});
