/**
 * Padrón de SUNAT (empresas, RUC 20): al escribir un RUC en Vender sale la razón social
 * oficial y un aviso si la empresa no está activa o no está habida.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/conexion.js';
import { buscarRuc, cargarPadron, leerLineaPadron, type FilaPadron } from '../../src/padron/padron.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

async function* de(lineas: string[]): AsyncIterable<FilaPadron> {
  for (const l of lineas) {
    const f = leerLineaPadron(l);
    if (f) yield f;
  }
}

describe('leer una línea del padrón', () => {
  it('guarda empresas (RUC 20) que no están de baja; no personas, ni bajas, ni títulos', () => {
    expect(leerLineaPadron('20100070970|SUPERMERCADOS  PERUANOS SOCIEDAD ANONIMA|ACTIVO|HABIDO|150131|AV.|-|-|-|-|-|-|-|-|-|'))
      .toEqual({ ruc: '20100070970', nombre: 'SUPERMERCADOS PERUANOS SOCIEDAD ANONIMA', estado: 'ACTIVO', condicion: 'HABIDO' });
    expect(leerLineaPadron('20600000013|EMPRESA SUSPENDIDA S.A.C.|SUSPENSION TEMPORAL|NO HABIDO|-|')).toMatchObject({ estado: 'SUSPENSION TEMPORAL', condicion: 'NO HABIDO' });
    expect(leerLineaPadron('RUC|NOMBRE O RAZÓN SOCIAL|ESTADO DEL CONTRIBUYENTE|CONDICIÓN DE DOMICILIO|')).toBeUndefined();
    expect(leerLineaPadron('10452159428|GARCIA CHANCO CARLOS AUGUSTO|ACTIVO|HABIDO|-|')).toBeUndefined();
    expect(leerLineaPadron('20111111111|CERRADA S.A.|BAJA DE OFICIO|NO HALLADO|-|')).toBeUndefined();
    expect(leerLineaPadron('20111111112|ANULADA S.A.|ANULACION - ERROR SU|-|-|')).toBeUndefined();
  });
});

describe.skipIf(!URL_PRUEBAS)('padrón de SUNAT', () => {
  let db: Db;
  let f: Fixture;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-padron-')));
    panel = panelDePrueba(crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } }), db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('antes de la primera carga no sabe nada (no avisa de más)', async () => {
    expect(await buscarRuc(db, '20100070970')).toBeNull();
  });

  it('carga por diferencias: solo cambia lo que cambió y quita a quien se dio de baja', async () => {
    const dia1 = ['20100070970|SUPERMERCADOS PERUANOS S.A.|ACTIVO|HABIDO|', '20600000013|CLIENTE EMPRESA S.A.C.|ACTIVO|HABIDO|', '20600000021|MUDADA S.A.C.|ACTIVO|HABIDO|'];
    expect(await cargarPadron(db, de(dia1), { minimo: 1, archivoDel: new Date('2026-11-06T12:00:00Z') })).toEqual({ filas: 3, cambios: 3, quitados: 0 });
    const dia2 = ['20100070970|SUPERMERCADOS PERUANOS S.A.|ACTIVO|HABIDO|', '20600000013|CLIENTE EMPRESA S.A.C.|ACTIVO|NO HABIDO|', '20600000021|MUDADA S.A.C.|BAJA DE OFICIO|-|'];
    expect(await cargarPadron(db, de(dia2), { minimo: 1, archivoDel: new Date('2026-11-07T12:00:00Z') })).toEqual({ filas: 2, cambios: 1, quitados: 1 });
    expect(await buscarRuc(db, '20600000013')).toEqual({ nombre: 'CLIENTE EMPRESA S.A.C.', estado: 'ACTIVO', condicion: 'NO HABIDO', al: '2026-11-07' });
    expect(await buscarRuc(db, '20600000021')).toBeUndefined();
  });

  it('un archivo cortado no borra el padrón bueno', async () => {
    await expect(cargarPadron(db, de(['20100070970|SUPERMERCADOS PERUANOS S.A.|ACTIVO|HABIDO|']), { minimo: 2 })).rejects.toThrow(/muy pocas empresas/);
    expect(await buscarRuc(db, '20600000013')).toMatchObject({ nombre: 'CLIENTE EMPRESA S.A.C.' });
  });

  it('en Vender: razón social oficial con aviso si no está habida o no figura activa; el DNI sigue igual', async () => {
    const cookie = await panel.entrar(f.empresaId, 'VENDEDOR');
    const buscar = async (doc: string) => {
      const r = await panel.pedir(`/panel/api/clientes?doc=${doc}`, { cookie });
      return { estado: r.status, ...(await r.json()) };
    };
    expect(await buscar('20100070970')).toEqual({ estado: 200, nombre: 'SUPERMERCADOS PERUANOS S.A.', fuente: 'SUNAT (padrón del 2026-11-07)' });
    expect(await buscar('20600000013')).toMatchObject({ nombre: 'CLIENTE EMPRESA S.A.C.', aviso: expect.stringMatching(/ACTIVO y NO HABIDO/) });
    expect(await buscar('20600000021')).toMatchObject({ estado: 200, aviso: expect.stringMatching(/no figura como empresa activa/) });
    expect((await buscar('12345678')).estado).toBe(404);
  });
});
