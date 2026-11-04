/**
 * Pruebas de firma con PostgreSQL real: certificado cifrado, firma única e inmutable.
 */
import { ahoraLima } from '../../src/fechas.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import { firmarComprobante, type ServiciosFirma } from '../../src/comprobantes/firmar-comprobante.js';
import type { Db } from '../../src/db/conexion.js';
import { guardarCertificado, obtenerCertificadoActivo } from '../../src/firma/repositorio-certificados.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { solicitudBoleta, solicitudFactura, validarContraXsd } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

const VERIFICADOR = fileURLToPath(new URL('../verificador_independiente.py', import.meta.url));
const CLAVE = 'clave-de-prueba';

describe.skipIf(!URL_PRUEBAS)('firma con base de datos', () => {
  let db: Db;
  let f: Fixture;
  let servicios: ServiciosFirma;
  let dirAlmacen: string;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    dirAlmacen = await mkdtemp(join(tmpdir(), 'almacen-pruebas-'));
    servicios = { almacen: new AlmacenLocal(dirAlmacen), llaveMaestra, algoritmo: 'SHA1' };
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
  });

  const cargar = (extra: Partial<Parameters<typeof guardarCertificado>[1]> = {}) =>
    guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba(), clave: CLAVE, llaveMaestra, ...extra });

  async function emitirBoleta(): Promise<string> {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalTienda, solicitud: solicitudBoleta() });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join());
    return r.guardado.id;
  }

  describe('certificado guardado', () => {
    it('se guarda cifrado: ni el .pfx ni la contraseña quedan legibles en la base', async () => {
      const pfx = crearPfxPrueba();
      await cargar();
      const r = await db.query(`SELECT pfx_cifrado, clave_pfx_cifrada, activo FROM certificados WHERE empresa_id = $1`, [f.empresaId]);
      expect(r.rows[0].activo).toBe(true);
      expect((r.rows[0].pfx_cifrado as Buffer).includes(pfx.subarray(0, 64))).toBe(false);
      expect((r.rows[0].clave_pfx_cifrada as Buffer).includes(Buffer.from(CLAVE))).toBe(false);
      const aud = await db.query(`SELECT despues::text AS t FROM auditoria WHERE empresa_id = $1 AND accion = 'CARGAR_CERTIFICADO'`, [f.empresaId]);
      expect(aud.rows[0].t).not.toContain(CLAVE);
    });

    it('se recupera con la llave maestra correcta', async () => {
      const { certificado } = await cargar();
      const activo = await obtenerCertificadoActivo(db, f.empresaId, llaveMaestra);
      expect(activo.certificado.huella).toBe(certificado.huella);
    });

    it('con otra llave maestra no se puede leer', async () => {
      await cargar();
      const otra = Buffer.from(generarLlaveMaestra(), 'base64');
      await expect(obtenerCertificadoActivo(db, f.empresaId, otra)).rejects.toThrow(/no se pudo descifrar/i);
    });

    it('copiar el certificado cifrado de una empresa a otra no sirve', async () => {
      await cargar();
      const otra = await crearEmpresa(db, '20100170338');
      await db.query(
        `INSERT INTO certificados (empresa_id, pfx_cifrado, clave_pfx_cifrada, numero_serie, emisor, valido_desde, valido_hasta)
         SELECT $2, pfx_cifrado, clave_pfx_cifrada, numero_serie, emisor, valido_desde, valido_hasta FROM certificados WHERE empresa_id = $1`,
        [f.empresaId, otra.empresaId],
      );
      await expect(obtenerCertificadoActivo(db, otra.empresaId, llaveMaestra)).rejects.toThrow(/no se pudo descifrar/i);
    });

    it('contraseña equivocada o certificado vencido: no se guarda nada', async () => {
      await expect(cargar({ clave: 'mala' })).rejects.toThrow('La contraseña del certificado .pfx no es correcta.');
      const vencido = crearPfxPrueba({ desde: new Date('2020-01-01'), hasta: new Date('2021-01-01') });
      await expect(cargar({ pfx: vencido })).rejects.toThrow(/venció/);
      const n = await db.query(`SELECT count(*)::int AS n FROM certificados WHERE empresa_id = $1`, [f.empresaId]);
      expect(n.rows[0].n).toBe(0);
    });

    it('cargar uno nuevo desactiva el anterior; no se borra ni se reactiva', async () => {
      const primero = await cargar();
      const segundo = await cargar({ pfx: crearPfxPrueba({ ruc: 'renovado' }) });
      const r = await db.query(`SELECT id, activo FROM certificados WHERE empresa_id = $1 ORDER BY creado_en`, [f.empresaId]);
      expect(r.rows.map((x) => [x.id, x.activo])).toEqual([[primero.id, false], [segundo.id, true]]);
      await expect(db.query(`DELETE FROM certificados WHERE id = $1`, [primero.id])).rejects.toThrow(/No se permite borrar/);
      await expect(db.query(`UPDATE certificados SET activo = true WHERE id = $1`, [primero.id])).rejects.toThrow(/no se modifica ni se reactiva/);
    });
  });

  describe('firmar comprobantes', () => {
    it('firma, guarda el XML, registra hash, certificado, historial y auditoría', async () => {
      const { id: certId } = await cargar();
      const id = await emitirBoleta();
      const r = await firmarComprobante(db, servicios, id);
      expect(r.yaFirmado).toBe(false);
      expect(r.ruta).toMatch(new RegExp(`^20\\d{9}/${ahoraLima().fecha.slice(0, 7).replace('-', '/')}/20\\d{9}-03-B001-1-[0-9a-f]{12}\\.xml$`));

      const c = await db.query(`SELECT hash_firma, firmado_con_certificado, firma_algoritmo, firmado_en, estado FROM comprobantes WHERE id = $1`, [id]);
      expect(c.rows[0].hash_firma).toBe(r.hashFirma);
      expect(c.rows[0].firmado_con_certificado).toBe(certId);
      expect(c.rows[0].firma_algoritmo).toBe('SHA1');
      expect(c.rows[0].estado).toBe('EMITIDO_LOCAL'); // se envía en la fase 4

      const archivo = await servicios.almacen.leer(r.ruta);
      expect(archivo.toString('utf8')).toBe(r.xmlFirmado);
      expect(execFileSync('python3', ['-I', VERIFICADOR], { input: archivo }).toString().trim()).toBe('OK rsa-sha1');
      expect(() => validarContraXsd(r.xmlFirmado, 'UBL-Invoice-2.1.xsd')).not.toThrow();

      const ev = await db.query(`SELECT detalle FROM comprobante_eventos WHERE comprobante_id = $1 ORDER BY id`, [id]);
      expect(ev.rows.at(-1)?.detalle).toMatch(/^XML firmado \(SHA1/);
      const aud = await db.query(`SELECT accion FROM auditoria WHERE entidad_id = $1 ORDER BY id`, [id]);
      expect(aud.rows.map((x) => x.accion)).toEqual(['EMITIR', 'FIRMAR']);
    });

    it('firmar de nuevo devuelve el mismo XML (no se regenera)', async () => {
      await cargar();
      const id = await emitirBoleta();
      const a = await firmarComprobante(db, servicios, id);
      await cargar({ pfx: crearPfxPrueba({ ruc: 'otro-cert' }) }); // aunque cambie el certificado
      const b = await firmarComprobante(db, servicios, id);
      expect(b.yaFirmado).toBe(true);
      expect(b.ruta).toBe(a.ruta);
      expect(b.xmlFirmado).toBe(a.xmlFirmado);
    });

    it('5 procesos firmando a la vez: una sola firma', async () => {
      await cargar();
      const id = await emitirBoleta();
      const rs = await Promise.all(Array.from({ length: 5 }, () => firmarComprobante(db, servicios, id)));
      expect(new Set(rs.map((r) => r.ruta)).size).toBe(1);
      expect(rs.filter((r) => !r.yaFirmado)).toHaveLength(1);
      const n = await db.query(`SELECT count(*)::int AS n FROM archivos WHERE entidad_id = $1`, [id]);
      expect(n.rows[0].n).toBe(1);
    });

    it('factura con SHA256 también verifica con el verificador independiente', async () => {
      await cargar();
      const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudFactura() });
      if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join());
      const firmado = await firmarComprobante(db, { ...servicios, algoritmo: 'SHA256' }, r.guardado.id);
      expect(execFileSync('python3', ['-I', VERIFICADOR], { input: firmado.xmlFirmado }).toString().trim()).toBe('OK rsa-sha256');
    });

    it('sin certificado: error claro y el comprobante queda intacto para reintentar', async () => {
      const id = await emitirBoleta();
      await expect(firmarComprobante(db, servicios, id)).rejects.toThrow(/no tiene un certificado digital activo/);
      const c = await db.query(`SELECT hash_firma FROM comprobantes WHERE id = $1`, [id]);
      expect(c.rows[0].hash_firma).toBeNull();
      await cargar();
      expect((await firmarComprobante(db, servicios, id)).yaFirmado).toBe(false);
    });

    it('certificado vencido al momento de firmar: no firma', async () => {
      await cargar();
      const id = await emitirBoleta();
      const enDosAnios = () => new Date(Date.now() + 2 * 365 * 86_400_000);
      await expect(firmarComprobante(db, { ...servicios, ahora: enDosAnios }, id)).rejects.toThrow(/venció/);
    });

    it('si alguien altera el XML guardado, se detecta', async () => {
      await cargar();
      const id = await emitirBoleta();
      const r = await firmarComprobante(db, servicios, id);
      await writeFile(join(dirAlmacen, r.ruta), r.xmlFirmado.replace('350.00', '1.00'));
      await expect(firmarComprobante(db, servicios, id)).rejects.toThrow(/fue alterado/);
    });

    it('la firma registrada no se puede cambiar', async () => {
      await cargar();
      const id = await emitirBoleta();
      await firmarComprobante(db, servicios, id);
      await expect(db.query(`UPDATE comprobantes SET hash_firma = 'otro' WHERE id = $1`, [id])).rejects.toThrow(/ya fue firmado/);
      await expect(
        db.query(`INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
                  VALUES ($1, 'comprobantes', $2, 'XML_FIRMADO', 'x', repeat('0', 64), 1, current_date + 2000)`, [f.empresaId, id]),
      ).rejects.toThrow(/archivos_un_xml_firmado/);
    });
  });
});

describe('almacén local', () => {
  it('no sobrescribe ni permite salir de su carpeta', async () => {
    const a = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-')));
    await a.guardar('x/a.xml', Buffer.from('uno'));
    await a.guardar('x/a.xml', Buffer.from('uno')); // reintento idéntico: OK
    await expect(a.guardar('x/a.xml', Buffer.from('dos'))).rejects.toThrow(/no se sobrescribe/);
    await expect(a.guardar('../fuera.xml', Buffer.from('x'))).rejects.toThrow(/no permitida/);
    await expect(a.guardar('/etc/passwd', Buffer.from('x'))).rejects.toThrow(/no permitida/);
    expect((await a.leer('x/a.xml')).toString()).toBe('uno');
  });
});
