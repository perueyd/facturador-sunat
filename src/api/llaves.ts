/**
 * Llaves de API: una por canal (tienda web, otra página…).
 *
 * Formato:  fk_<prefijo>_<secreto>
 *   - prefijo: 12 caracteres hex, público, sirve para encontrar la llave.
 *   - secreto: 32 bytes aleatorios; en la base solo se guarda su SHA-256.
 * La llave completa se muestra UNA vez al crearla. Si se filtra, se revoca y se crea otra.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { enTransaccion, type Db, type Tx } from '../db/conexion.js';

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

/** Tope de páginas conectadas a la vez: más que eso suele ser un error (o alguien abusando). */
const MAXIMO_CONEXIONES = 10;

/**
 * Conectar una página web desde el panel (antes solo con un comando en la PC): crea su canal de
 * tipo API (o reutiliza el de ese nombre, ej. "Tienda web") y una llave nueva con los permisos de
 * siempre (emitir, consultar, cobrar; anular nunca: eso se hace en el panel).
 * Una sola llave activa por canal: así "Desconectar" corta de verdad esa página.
 */
export async function crearConexion(
  db: Db,
  d: { empresaId: string; nombre: string; usuarioId?: string },
): Promise<{ llave: string; prefijo: string; canal: string }> {
  const nombre = d.nombre.replace(/\s+/g, ' ').trim();
  if (nombre.length < 2 || nombre.length > 60) throw new ErrorLlave('Ponle un nombre de 2 a 60 letras, ej. "Tienda de María".');
  return enTransaccion(db, async (q) => {
    // Dos clics seguidos no deben dejar dos llaves activas para la misma página.
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('conexion-' || $1))`, [d.empresaId]);
    const activas = await q.query(`SELECT count(*)::int AS n FROM api_llaves WHERE empresa_id = $1 AND revocada_en IS NULL`, [d.empresaId]);
    if (activas.rows[0].n >= MAXIMO_CONEXIONES) throw new ErrorLlave(`Ya tienes ${MAXIMO_CONEXIONES} páginas conectadas. Desconecta una que ya no uses.`);
    const existente = await q.query(
      `SELECT c.id, c.nombre, c.tipo, c.activo, EXISTS (SELECT 1 FROM api_llaves l WHERE l.canal_id = c.id AND l.revocada_en IS NULL) AS conectada
         FROM canales c WHERE c.empresa_id = $1 AND lower(c.nombre) = lower($2)`,
      [d.empresaId, nombre],
    );
    const c = existente.rows[0];
    if (c && c.tipo !== 'API') throw new ErrorLlave(`"${nombre}" es una forma de venta del panel (no una página). Elige otro nombre.`);
    if (c?.conectada) throw new ErrorLlave(`"${nombre}" ya está conectada. Si perdiste su llave, desconéctala y conéctala de nuevo.`);
    let canalId = c?.id as string | undefined;
    if (canalId && !c.activo) await q.query(`UPDATE canales SET activo = true WHERE id = $1`, [canalId]);
    if (!canalId) {
      // La marca de siempre de la empresa (la de sus otros canales), para que el PDF salga igual.
      const r = await q.query(
        `INSERT INTO canales (empresa_id, nombre, tipo, formato_pdf, marca_id_por_defecto)
         VALUES ($1, $2, 'API', 'A4', (SELECT marca_id_por_defecto FROM canales WHERE empresa_id = $1 AND marca_id_por_defecto IS NOT NULL ORDER BY creado_en LIMIT 1))
         RETURNING id`,
        [d.empresaId, nombre],
      );
      canalId = r.rows[0].id as string;
    }
    const { llave, prefijo } = await crearLlaveApi(q, { empresaId: d.empresaId, canalId, ...(d.usuarioId ? { usuarioId: d.usuarioId } : {}) });
    return { llave, prefijo, canal: (c?.nombre as string | undefined) ?? nombre };
  });
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
