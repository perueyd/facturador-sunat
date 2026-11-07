/**
 * Llaves de API: una por canal (tienda web, otra página…).
 *
 * Formato:  fk_<prefijo>_<secreto>
 *   - prefijo: 12 caracteres hex, público, sirve para encontrar la llave.
 *   - secreto: 32 bytes aleatorios; en la base solo se guarda su SHA-256.
 * La llave completa se muestra UNA vez al crearla. Si se filtra, se revoca y se crea otra.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Tx } from '../db/conexion.js';

export const PERMISOS = ['emitir', 'consultar', 'cobrar', 'anular'] as const;
export type Permiso = (typeof PERMISOS)[number];

export interface ContextoLlave {
  apiLlaveId: string;
  empresaId: string;
  canalId: string;
  canalNombre: string;
  permisos: Permiso[];
}

const PATRON = /^fk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const huella = (secreto: string) => createHash('sha256').update(secreto, 'utf8').digest('hex');

export class ErrorLlave extends Error {}

export async function crearLlaveApi(
  q: Db | Tx,
  d: { empresaId: string; canalId: string; permisos?: Permiso[]; usuarioId?: string },
): Promise<{ id: string; llave: string; prefijo: string }> {
  const permisos = d.permisos ?? ['emitir', 'consultar', 'cobrar'];
  if (permisos.length === 0 || permisos.some((p) => !PERMISOS.includes(p))) {
    throw new ErrorLlave(`Permisos válidos: ${PERMISOS.join(', ')}.`);
  }
  const canal = await q.query(`SELECT tipo FROM canales WHERE id = $1 AND empresa_id = $2`, [d.canalId, d.empresaId]);
  if (!canal.rows[0]) throw new ErrorLlave('El canal no existe o no pertenece a esta empresa.');
  if (canal.rows[0].tipo !== 'API') throw new ErrorLlave('Solo los canales de tipo API usan llaves.');
  const prefijo = randomBytes(6).toString('hex');
  const secreto = randomBytes(32).toString('base64url');
  const r = await q.query(
    `INSERT INTO api_llaves (empresa_id, canal_id, prefijo, hash, permisos) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [d.empresaId, d.canalId, prefijo, huella(secreto), JSON.stringify(permisos)],
  );
  const id = r.rows[0].id as string;
  await q.query(
    `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'CREAR_LLAVE_API', 'api_llaves', $3, $4)`,
    [d.empresaId, d.usuarioId ?? null, id, JSON.stringify({ prefijo, canal: d.canalId, permisos })],
  );
  return { id, prefijo, llave: `fk_${prefijo}_${secreto}` };
}

/** Devuelve el contexto de la llave, o undefined si no es válida (sin decir por qué, a propósito). */
export async function autenticarLlave(q: Db | Tx, llave: string): Promise<ContextoLlave | undefined> {
  const m = PATRON.exec(llave);
  if (!m) return undefined;
  const [, prefijo, secreto] = m as unknown as [string, string, string];
  const r = await q.query(
    `SELECT l.id, l.empresa_id, l.canal_id, l.hash, l.permisos, c.nombre AS canal_nombre
     FROM api_llaves l JOIN canales c ON c.id = l.canal_id
     WHERE l.prefijo = $1 AND l.revocada_en IS NULL AND c.activo`,
    [prefijo],
  );
  const f = r.rows[0];
  if (!f) return undefined;
  // Comparación en tiempo constante para no dar pistas sobre el secreto.
  const esperado = Buffer.from(f.hash as string, 'hex');
  const recibido = Buffer.from(huella(secreto), 'hex');
  if (esperado.length !== recibido.length || !timingSafeEqual(esperado, recibido)) return undefined;
  void q.query(`UPDATE api_llaves SET ultimo_uso_en = now() WHERE id = $1`, [f.id]).catch(() => undefined);
  return { apiLlaveId: f.id, empresaId: f.empresa_id, canalId: f.canal_id, canalNombre: f.canal_nombre, permisos: f.permisos as Permiso[] };
}

export async function revocarLlave(q: Db | Tx, empresaId: string, prefijo: string, usuarioId?: string): Promise<boolean> {
  const r = await q.query(
    `UPDATE api_llaves SET revocada_en = now(), revocada_por = $3 WHERE empresa_id = $1 AND prefijo = $2 AND revocada_en IS NULL RETURNING id`,
    [empresaId, prefijo, usuarioId ?? null],
  );
  const id = r.rows[0]?.id as string | undefined;
  if (!id) return false;
  await q.query(
    `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'REVOCAR_LLAVE_API', 'api_llaves', $3, $4)`,
    [empresaId, usuarioId ?? null, id, JSON.stringify({ prefijo })],
  );
  return true;
}

export interface LlaveListada {
  prefijo: string;
  canal: string;
  creada: string;
  ultimoUso: string | null;
  activa: boolean;
}

/** Llaves de la empresa (sin el secreto: nunca se guarda), las activas primero. */
export async function listarLlaves(q: Db | Tx, empresaId: string): Promise<LlaveListada[]> {
  const r = await q.query(
    `SELECT l.prefijo, c.nombre AS canal, l.creado_en, l.ultimo_uso_en, l.revocada_en IS NULL AS activa
       FROM api_llaves l JOIN canales c ON c.id = l.canal_id
      WHERE l.empresa_id = $1 ORDER BY (l.revocada_en IS NULL) DESC, l.creado_en DESC LIMIT 50`,
    [empresaId],
  );
  return r.rows.map((f) => ({
    prefijo: f.prefijo, canal: f.canal, creada: new Date(f.creado_en).toISOString(),
    ultimoUso: f.ultimo_uso_en ? new Date(f.ultimo_uso_en).toISOString() : null, activa: f.activa,
  }));
}
