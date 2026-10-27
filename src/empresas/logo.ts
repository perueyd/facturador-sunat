/**
 * Logo de la empresa para el PDF de sus comprobantes. Se guarda en el almacén (nunca se
 * borra el anterior: los PDF viejos pueden necesitarlo) y la empresa apunta al nuevo.
 */
import { createHash } from 'node:crypto';
import type { Almacen } from '../almacen/almacen.js';
import { enTransaccion, type Db } from '../db/conexion.js';

export const LOGO_MAXIMO_BYTES = 70 * 1024;
export class ErrorLogo extends Error {}

/** Solo PNG o JPEG, reconocidos por su contenido (no por lo que diga el nombre). */
export function tipoImagen(datos: Buffer): 'png' | 'jpg' | undefined {
  if (datos.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (datos[0] === 0xff && datos[1] === 0xd8 && datos[2] === 0xff) return 'jpg';
  return undefined;
}

export async function guardarLogo(db: Db, almacen: Almacen, d: { empresaId: string; imagen: Buffer; usuarioId?: string }): Promise<void> {
  const tipo = tipoImagen(d.imagen);
  if (!tipo) throw new ErrorLogo('El logo debe ser una imagen PNG o JPG.');
  if (d.imagen.length > LOGO_MAXIMO_BYTES) throw new ErrorLogo('El logo es muy pesado (máximo 70 KB).');
  const sha256 = createHash('sha256').update(d.imagen).digest('hex');
  const ruc = (await db.query(`SELECT ruc FROM empresas WHERE id = $1`, [d.empresaId])).rows[0]?.ruc as string;
  const ruta = `${ruc}/logo/logo-${sha256.slice(0, 16)}.${tipo}`;
  await almacen.guardar(ruta, d.imagen);
  await enTransaccion(db, async (tx) => {
    const a = await tx.query(
      `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
       VALUES ($1, 'empresas', $1, 'LOGO', $2, $3, $4, (current_date + interval '6 years')::date) RETURNING id`,
      [d.empresaId, ruta, sha256, d.imagen.length],
    );
    await tx.query(`UPDATE empresas SET logo_archivo_id = $2 WHERE id = $1`, [d.empresaId, a.rows[0].id]);
    await tx.query(
      `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'CAMBIAR_LOGO', 'empresas', $1, $3)`,
      [d.empresaId, d.usuarioId ?? null, JSON.stringify({ archivo: a.rows[0].id, sha256 })],
    );
  });
}
