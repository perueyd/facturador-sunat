/**
 * Comprobantes antiguos (función opcional): XML de SUNAT emitidos antes de este facturador,
 * guardados solo para consultar. Nunca cuentan como ventas ni tocan los correlativos.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { leerXmlAntiguo, listarAntiguos, subirAntiguos } from '../../src/antiguos/antiguos.js';
import { crearApp } from '../../src/api/app.js';
import { prepararComprobante } from '../../src/comprobantes/preparar.js';
import type { Db } from '../../src/db/conexion.js';
import { leerPfx } from '../../src/firma/certificado.js';
import { firmarXml } from '../../src/firma/firmar.js';
import type { Rol } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { generarXmlComprobante } from '../../src/xml/comprobante.js';
import { contextoPrueba, solicitudBoleta, solicitudFactura } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

const certificado = leerPfx(crearPfxPrueba(), 'clave-de-prueba');

/** Un XML como los que descarga SUNAT: firmado, con la serie que se le indique (ej. E001 de SOL). */
function xmlDeSunat(serie: string, numero: number, o: { factura?: boolean; ruc?: string } = {}): string {
  const r = prepararComprobante(o.factura ? solicitudFactura() : solicitudBoleta(), contextoPrueba);
  if (!r.ok) throw new Error(r.errores.join(' '));
  const c = { ...r.comprobante, numero };
  let xml = generarXmlComprobante(c).replace(`<cbc:ID>${c.serie}-${numero}</cbc:ID>`, `<cbc:ID>${serie}-${numero}</cbc:ID>`);
  if (o.ruc) xml = xml.replaceAll(contextoPrueba.empresa.ruc, o.ruc);
  return firmarXml(xml, certificado, 'SHA256').xmlFirmado;
}

describe.skipIf(!URL_PRUEBAS)('comprobantes antiguos', () => {
  let db: Db;
  let f: Fixture;
  let almacen: AlmacenLocal;
  let app: ReturnType<typeof crearApp>;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-antiguos-')));
    app = crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } });
    panel = panelDePrueba(app, db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  const subir = (nombre: string, contenido: string | Buffer) =>
    subirAntiguos(db, almacen, { empresaId: f.empresaId, nombre, contenido: typeof contenido === 'string' ? Buffer.from(contenido) : contenido });

  it('lee serie, número, fecha, cliente y totales del XML de SUNAT', () => {
    const x = leerXmlAntiguo(xmlDeSunat('E001', 25, { factura: true }));
    expect(x).toMatchObject({ tipo: '01', serie: 'E001', numero: 25, rucEmisor: contextoPrueba.empresa.ruc, moneda: 'PEN', total: '1299.80' });
    expect(x.cliente).toMatchObject({ tipoDoc: '6', nombre: 'CLIENTE EMPRESA S.A.C.' });
    expect(() => leerXmlAntiguo('%PDF-1.4 esto es un PDF')).toThrow(/XML \(no el PDF\)/);
  });

  it('guarda, no duplica, comprueba la firma y rechaza los de otro RUC', async () => {
    const xml = xmlDeSunat('EB01', 7);
    expect(await subir('EB01-7.xml', xml)).toEqual([{ archivo: 'EB01-7.xml', resultado: 'GUARDADO', comprobante: 'Boleta EB01-00000007' }]);
    expect((await subir('otra-vez.xml', xml))[0]).toMatchObject({ resultado: 'REPETIDO' });
    // Alterado después de firmar: se guarda, pero se avisa.
    const alterado = xmlDeSunat('EB01', 8).replace('JUAN PÉREZ', 'OTRO NOMBRE');
    expect((await subir('EB01-8.xml', alterado))[0]).toMatchObject({ resultado: 'GUARDADO', mensaje: expect.stringMatching(/firma no se pudo comprobar/) });
    expect((await subir('ajeno.xml', xmlDeSunat('E001', 1, { factura: true, ruc: '20100070970' })))[0]).toMatchObject({
      resultado: 'ERROR', mensaje: expect.stringMatching(/RUC 20100070970, no de esta empresa/),
    });
    const lista = await listarAntiguos(db, f.empresaId);
    expect(lista.map((x) => [x.comprobante, x.firmaValida])).toEqual([['EB01-00000008', false], ['EB01-00000007', true]]);
    // Solo inserción, como los comprobantes: no se cambia ni se borra.
    await expect(db.query(`UPDATE comprobantes_antiguos SET total = 0`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM comprobantes_antiguos`)).rejects.toThrow();
  });

  it('un ZIP de SUNAT: guarda cada XML y omite la constancia (R-...)', async () => {
    const zip = Buffer.from(zipSync({
      'E001-30.xml': strToU8(xmlDeSunat('E001', 30, { factura: true })),
      'E001-31.xml': strToU8(xmlDeSunat('E001', 31, { factura: true })),
      'R-20600000005-01-E001-30.xml': strToU8('<ar:ApplicationResponse/>'),
      'E001-30.pdf': strToU8('%PDF'),
    }));
    const r = await subir('descarga.zip', zip);
    expect(r.map((x) => [x.comprobante, x.resultado])).toEqual([['Factura E001-00000030', 'GUARDADO'], ['Factura E001-00000031', 'GUARDADO']]);
    expect((await listarAntiguos(db, f.empresaId, { buscar: 'E001-3' })).length).toBe(2);
    expect(await listarAntiguos(db, f.empresaId, { buscar: '%' })).toEqual([]);
  });

  // Revisión de seguridad 07/11/2026: un ZIP que miente sobre su tamaño (dice 10 bytes y trae
  // 20 MB de ceros) se descomprimía entero antes de descartarlo. Ahora se corta al pasar 1 MB.
  it('un ZIP "bomba" se corta al pasar 1 MB, aunque mienta sobre su tamaño', async () => {
    const zip = Buffer.from(zipSync({ 'bomba.xml': new Uint8Array(20 * 1024 * 1024) }, { level: 9 }));
    for (let i = 0; i < zip.length - 4; i++) {
      const firma = zip.readUInt32LE(i);
      if (firma === 0x04034b50) zip.writeUInt32LE(10, i + 22);
      if (firma === 0x02014b50) zip.writeUInt32LE(10, i + 24);
    }
    const inicio = Date.now();
    await expect(subir('bomba.zip', zip)).rejects.toThrow(/pesa más de 1 MB/);
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it('nunca toca ventas ni correlativos; avisa si la serie es una del facturador', async () => {
    const antes = (await db.query(`SELECT count(*)::int AS n, (SELECT sum(ultimo_numero)::int FROM series WHERE empresa_id = $1) AS s FROM comprobantes WHERE empresa_id = $1`, [f.empresaId])).rows[0];
    expect((await subir('B001-5.xml', xmlDeSunat('B001', 5)))[0]).toMatchObject({ resultado: 'GUARDADO', mensaje: expect.stringMatching(/serie B001 también la usa este facturador/) });
    const despues = (await db.query(`SELECT count(*)::int AS n, (SELECT sum(ultimo_numero)::int FROM series WHERE empresa_id = $1) AS s FROM comprobantes WHERE empresa_id = $1`, [f.empresaId])).rows[0];
    expect(despues).toEqual(antes);
  });

  // ---------- Desde el panel ----------

  const entrar = (rol: Rol) => panel.entrar(f.empresaId, rol);
  const pedir: typeof panel.pedir = (ruta, o) => panel.pedir(ruta, o);

  it('viene apagada; solo el dueño la prende; el contador consulta y no sube', async () => {
    const dueno = await entrar('DUENO');
    const admin = await entrar('ADMIN');
    const contador = await entrar('CONTADOR');
    const vendedor = await entrar('VENDEDOR');
    const yo = await (await pedir('/panel/api/yo', { cookie: dueno })).json();
    expect(yo.empresa.modulos).not.toContain('antiguos');
    expect((await pedir('/panel/api/antiguos', { cookie: dueno })).status).toBe(403);

    expect((await pedir('/panel/api/antiguos/activar', { cookie: admin, cuerpo: { activo: true } })).status).toBe(403);
    expect((await pedir('/panel/api/antiguos/activar', { cookie: dueno, cuerpo: { activo: true } })).status).toBe(200);

    const archivo = Buffer.from(xmlDeSunat('E001', 40, { factura: true })).toString('base64');
    expect((await pedir('/panel/api/antiguos', { cookie: contador, cuerpo: { nombre: 'E001-40.xml', archivo } })).status).toBe(403);
    const r = await pedir('/panel/api/antiguos', { cookie: admin, cuerpo: { nombre: 'E001-40.xml', archivo: `data:text/xml;base64,${archivo}` } });
    expect((await r.json()).resultados).toEqual([expect.objectContaining({ resultado: 'GUARDADO', comprobante: 'Factura E001-00000040' })]);

    const lista = await (await pedir('/panel/api/antiguos?buscar=E001-40', { cookie: contador })).json();
    expect(lista.comprobantes).toEqual([expect.objectContaining({ comprobante: 'E001-00000040', tipo: 'Factura', total: '1299.80', firmaValida: true })]);
    const xml = await pedir(`/panel/api/antiguos/${lista.comprobantes[0].id}/xml`, { cookie: contador });
    expect(xml.headers.get('content-disposition')).toMatch(/attachment; filename="20600000005-01-E001-40.xml"/);
    expect(await xml.text()).toContain('E001-40');
    expect((await pedir('/panel/api/antiguos', { cookie: vendedor })).status).toBe(403);

    // Apagarla solo la oculta: al prenderla de nuevo, lo subido sigue ahí.
    expect((await pedir('/panel/api/antiguos/activar', { cookie: dueno, cuerpo: { activo: false } })).status).toBe(200);
    expect((await pedir('/panel/api/antiguos', { cookie: dueno })).status).toBe(403);
    await pedir('/panel/api/antiguos/activar', { cookie: dueno, cuerpo: { activo: true } });
    expect((await (await pedir('/panel/api/antiguos?buscar=E001-40', { cookie: dueno })).json()).comprobantes).toHaveLength(1);
  });
});
