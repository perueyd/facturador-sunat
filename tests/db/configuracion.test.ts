/**
 * Configuración de empresas y credenciales SOL de producción.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/conexion.js';
import { configurarEmpresa, type DatosEmpresa } from '../../src/empresas/configurar.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { credencialesSunat, guardarCredencialesSol } from '../../src/sunat/configuracion.js';
import { URL_PRUEBAS, prepararBase } from './base-prueba.js';

const datos: DatosEmpresa = {
  ruc: '20616613074', razonSocial: 'CORPORACION AGAMENON S.A.C.', ubigeo: '150101', departamento: 'LIMA',
  provincia: 'LIMA', distrito: 'LIMA', direccion: 'AV. EJEMPLO 123', regimen: 'MYPE_TRIBUTARIO', regimenDesde: '2026-01-01',
  marca: 'Espacios y Diseño',
};

describe.skipIf(!URL_PRUEBAS)('configuración', () => {
  let db: Db;
  const llave = Buffer.from(generarLlaveMaestra(), 'base64');
  beforeAll(async () => {
    db = await prepararBase();
  });
  afterAll(async () => {
    await db?.end();
  });

  it('configurar una empresa dos veces no duplica nada y actualiza sus datos', async () => {
    const a = await configurarEmpresa(db, datos);
    const b = await configurarEmpresa(db, { ...datos, direccion: 'AV. NUEVA 456' });
    expect(a).toEqual({ empresaId: a.empresaId, creada: true });
    expect(b).toEqual({ empresaId: a.empresaId, creada: false });
    const r = await db.query(
      `SELECT (SELECT count(*)::int FROM series WHERE empresa_id = $1) AS series,
              (SELECT count(*)::int FROM canales WHERE empresa_id = $1) AS canales,
              (SELECT count(*)::int FROM marcas WHERE empresa_id = $1) AS marcas,
              (SELECT direccion FROM empresas WHERE id = $1) AS direccion,
              (SELECT formato_pdf FROM canales WHERE empresa_id = $1 AND nombre = 'Presencial') AS formato_presencial`,
      [a.empresaId],
    );
    expect(r.rows[0]).toEqual({ series: 6, canales: 4, marcas: 1, direccion: 'AV. NUEVA 456', formato_presencial: 'TICKET_80' });
  });

  it('rechaza RUC o ubigeo inválidos', async () => {
    await expect(configurarEmpresa(db, { ...datos, ruc: '20616613075' })).rejects.toThrow(/RUC inválido/);
    await expect(configurarEmpresa(db, { ...datos, ubigeo: '15' })).rejects.toThrow(/ubigeo/);
  });

  it('credenciales SOL: beta usa MODDATOS; producción, el usuario secundario guardado cifrado', async () => {
    const { empresaId } = await configurarEmpresa(db, datos);
    expect(await credencialesSunat(db, empresaId, datos.ruc, 'BETA', llave)).toEqual({ usuario: '20616613074MODDATOS', clave: 'MODDATOS' });
    await expect(credencialesSunat(db, empresaId, datos.ruc, 'PRODUCCION', llave)).rejects.toThrow(/usuario SOL secundario/);

    await guardarCredencialesSol(db, empresaId, 'caeabc26', 'Clave12345ab', llave);
    expect(await credencialesSunat(db, empresaId, datos.ruc, 'PRODUCCION', llave)).toEqual({ usuario: '20616613074CAEABC26', clave: 'Clave12345ab' });
    const guardado = await db.query(`SELECT clave_cifrada FROM credenciales_sol WHERE empresa_id = $1`, [empresaId]);
    expect((guardado.rows[0].clave_cifrada as Buffer).includes(Buffer.from('Clave12345ab'))).toBe(false);
    await expect(guardarCredencialesSol(db, empresaId, '20616613074CAEABC26 ', 'x', llave)).rejects.toThrow(/sin el RUC/);
  });
});
