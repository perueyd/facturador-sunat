/**
 * Firma un comprobante ya emitido y guarda su XML firmado.
 *
 * - Una sola vez: si ya tiene XML firmado, devuelve ese (nunca se regenera; así
 *   lo que se envía a SUNAT es exactamente lo que se firmó).
 * - Bloquea el comprobante mientras firma, para que dos procesos no lo firmen a la vez.
 * - El certificado se descifra solo en memoria.
 */
import { createHash } from 'node:crypto';
import type { Almacen } from '../almacen/almacen.js';
import { enTransaccion, type Db } from '../db/conexion.js';
import { firmarXml, type AlgoritmoFirma } from '../firma/firmar.js';
import { obtenerCertificadoActivo } from '../firma/repositorio-certificados.js';
import { idComprobanteLegible } from '../tipos.js';
import { generarXmlComprobante } from '../xml/comprobante.js';
import { nombreArchivoComprobante } from '../xml/nombres.js';
import { cargarComprobante } from './repositorio.js';

export interface ServiciosFirma {
  almacen: Almacen;
  llaveMaestra: Buffer;
  algoritmo: AlgoritmoFirma;
  ahora?: () => Date;
}

export interface ComprobanteFirmado {
  ruta: string;
  hashFirma: string;
  xmlFirmado: string;
  /** true si ya estaba firmado y se devolvió lo existente. */
  yaFirmado: boolean;
}

export async function firmarComprobante(db: Db, s: ServiciosFirma, comprobanteId: string): Promise<ComprobanteFirmado> {
  return enTransaccion(db, async (tx) => {
    // 1) Bloquear el comprobante. Si otro proceso lo está firmando, esperamos aquí.
    const fila = await tx.query(
      `SELECT empresa_id, hash_firma, estado FROM comprobantes WHERE id = $1 FOR UPDATE`,
      [comprobanteId],
    );
    const f = fila.rows[0];
    if (!f) throw new Error('Comprobante no encontrado.');

    // 2) Recién con el bloqueo tomado, buscar si ya tiene XML firmado. Debe ser una consulta
    //    aparte: si fuera un JOIN en la consulta anterior, PostgreSQL no volvería a leer
    //    `archivos` tras la espera y no vería la firma que el otro proceso acaba de guardar.
    const existente = await tx.query(
      `SELECT ruta_almacenamiento, sha256 FROM archivos
       WHERE entidad = 'comprobantes' AND entidad_id = $1 AND tipo = 'XML_FIRMADO'`,
      [comprobanteId],
    );
    const a = existente.rows[0];
    if (a) {
      const contenido = await s.almacen.leer(a.ruta_almacenamiento, tx);
      if (createHash('sha256').update(contenido).digest('hex') !== a.sha256) {
        throw new Error(`El XML firmado guardado en "${a.ruta_almacenamiento}" fue alterado (su huella no coincide).`);
      }
      return { ruta: a.ruta_almacenamiento, hashFirma: f.hash_firma, xmlFirmado: contenido.toString('utf8'), yaFirmado: true };
    }
    if (f.estado !== 'EMITIDO_LOCAL') {
      throw new Error(`El comprobante está en estado ${f.estado}; solo se firman comprobantes recién emitidos.`);
    }

    const ahora = s.ahora?.() ?? new Date();
    const { comprobante: c } = await cargarComprobante(tx, comprobanteId);
    const { id: certificadoId, certificado } = await obtenerCertificadoActivo(tx, f.empresa_id, s.llaveMaestra, ahora);
    const firma = firmarXml(generarXmlComprobante(c), certificado, s.algoritmo);

    const contenido = Buffer.from(firma.xmlFirmado, 'utf8');
    const sha256 = createHash('sha256').update(contenido).digest('hex');
    const nombre = nombreArchivoComprobante(c.empresa.ruc, c.tipo, c.serie, c.numero);
    const [anio, mes] = c.fechaEmision.split('-');
    // La huella en el nombre evita choques si un intento anterior falló a medias.
    const ruta = `${c.empresa.ruc}/${anio}/${mes}/${nombre}-${sha256.slice(0, 12)}.xml`;

    // Primero el archivo, luego el registro: si la base falla, queda un archivo huérfano
    // inofensivo; nunca un registro que apunte a un archivo inexistente.
    await s.almacen.guardar(ruta, contenido, tx);
    await tx.query(
      `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
       VALUES ($1, 'comprobantes', $2, 'XML_FIRMADO', $3, $4, $5, (current_date + interval '6 years')::date)`,
      [f.empresa_id, comprobanteId, ruta, sha256, contenido.length],
    );
    await tx.query(
      `UPDATE comprobantes SET hash_firma = $2, firmado_con_certificado = $3, firma_algoritmo = $4, firmado_en = $5 WHERE id = $1`,
      [comprobanteId, firma.digestValue, certificadoId, s.algoritmo, ahora],
    );
    await tx.query(
      `INSERT INTO comprobante_eventos (comprobante_id, estado_anterior, estado_nuevo, detalle)
       VALUES ($1, $2, $2, $3)`,
      [comprobanteId, f.estado, `XML firmado (${s.algoritmo}, certificado ${certificado.huella.slice(0, 23)}…)`],
    );
    await tx.query(
      `INSERT INTO auditoria (empresa_id, accion, entidad, entidad_id, despues)
       VALUES ($1, 'FIRMAR', 'comprobantes', $2, $3)`,
      [f.empresa_id, comprobanteId, JSON.stringify({ comprobante: idComprobanteLegible(c.serie, c.numero), ruta, sha256, algoritmo: s.algoritmo })],
    );
    return { ruta, hashFirma: firma.digestValue, xmlFirmado: firma.xmlFirmado, yaFirmado: false };
  });
}
