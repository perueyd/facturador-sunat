/**
 * Revisión de seguridad del 07/11/2026: las funciones nuevas (comprobantes subidos de SUNAT,
 * ventas sin internet, conexiones, "ya declaré", productos) nunca dejan ver ni tocar datos de
 * OTRA empresa, aunque se adivine o copie un identificador.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { crearLlaveApi } from '../../src/api/llaves.js';
import { registrarContingencia } from '../../src/contingencia/contingencia.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('aislamiento entre empresas en las funciones nuevas', () => {
  let db: Db;
  let a: Fixture;
  let b: Fixture;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const hoy = ahoraLima().fecha;

  beforeAll(async () => {
    db = await prepararBase();
    a = await crearEmpresa(db);
    b = await crearEmpresa(db, `2060000003${digitoVerificadorRuc('2060000003')}`);
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-aislamiento-')));
    panel = panelDePrueba(crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } }), db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('la empresa B no ve ni toca lo de la empresa A', async () => {
    // Datos de A: una venta sin internet, un comprobante subido de SUNAT y una llave de API.
    await registrarContingencia(db, { empresaId: a.empresaId, cuerpo: {
      tipo: 'BOLETA', items: [{ descripcion: 'Tarima', cantidad: 1, precio: '350.00' }],
      contingencia: { origen: 'SINRED-de-la-empresa-A', serie: '0001', numero: 1, fecha: hoy, hora: '10:00' },
    } });
    const archivo = (await db.query(
      `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
       VALUES ($1, 'comprobantes_antiguos', $1, 'XML', 'a/x.xml', repeat('a', 64), 1, current_date + 2200) RETURNING id`, [a.empresaId],
    )).rows[0].id;
    const antiguo = (await db.query(
      `INSERT INTO comprobantes_antiguos (empresa_id, tipo, serie, numero, fecha_emision, moneda, total, igv, firma_valida, archivo_id)
       VALUES ($1, '03', 'EB01', 1, $2, 'PEN', 100, 15.25, true, $3) RETURNING id`, [a.empresaId, hoy, archivo],
    )).rows[0].id;
    const { prefijo } = await crearLlaveApi(db, { empresaId: a.empresaId, canalId: a.canalTienda });

    // El dueño de B (con todas las funciones prendidas) intenta llegar a ellos.
    await db.query(`UPDATE empresas SET modulos_desactivados = '{}' WHERE id = $1`, [b.empresaId]);
    const duenoB = await panel.entrar(b.empresaId, 'DUENO');
    const pedir = (ruta: string, cuerpo?: unknown) => panel.pedir(ruta, { cookie: duenoB, ...(cuerpo !== undefined ? { cuerpo } : {}) });

    expect((await pedir(`/panel/api/antiguos/${antiguo}/xml`)).status).toBe(404);
    expect((await (await pedir('/panel/api/antiguos')).json()).comprobantes).toEqual([]);
    expect((await (await pedir('/panel/api/contingencia')).json()).dias).toEqual([]);
    expect((await pedir('/panel/api/contingencia/informe', { fecha: hoy })).status).toBe(422);
    expect((await (await pedir('/panel/api/llaves')).json()).llaves).toEqual([]);
    expect((await pedir(`/panel/api/llaves/${prefijo}/desactivar`, {})).status).toBe(404);
    expect((await db.query(`SELECT revocada_en FROM api_llaves WHERE prefijo = $1`, [prefijo])).rows[0].revocada_en).toBeNull();
    expect((await (await pedir('/panel/api/vendidos')).json()).vendidos).toEqual([]);
    // "Ya declaré" de B solo marca a B.
    expect((await pedir('/panel/api/declaraciones', { periodo: '2026-10', declarado: true })).status).toBe(200);
    expect((await db.query(`SELECT empresa_id FROM declaraciones_mensuales`)).rows).toEqual([{ empresa_id: b.empresaId }]);
    // Las ventas de A no aparecen en la Caja ni en las Estadísticas de B.
    const caja = await (await pedir(`/panel/api/caja?desde=${hoy}&hasta=${hoy}`)).json();
    expect(caja.vendido ?? '0.00').toBe('0.00');
  });
});
