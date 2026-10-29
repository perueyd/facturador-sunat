/**
 * Invitar a una persona al panel con un ENLACE (por WhatsApp o correo).
 *
 *   1. Quien invita escribe el correo, el nombre y el rol → se crea el usuario SIN contraseña.
 *   2. La persona abre el enlace, pone su contraseña y conecta su app autenticadora.
 *   3. Confirma con el código de la app → queda activa y recibe sus códigos de respaldo.
 *
 * El enlace vale 72 horas y una sola vez; generar otro anula el anterior. Mientras no se
 * active, el usuario no puede entrar (no tiene contraseña ni segundo paso).
 */
import { createHash, randomBytes } from 'node:crypto';
import { enTransaccion, type Db } from '../db/conexion.js';
import { hashContrasena } from '../seguridad/contrasenas.js';
import { activarTotp, asignarEmpresa, nuevoSecretoTotp, nuevosCodigosRespaldo, type Rol } from './usuarios.js';

const HORAS_INVITACION = 72;
const huella = (token: string) => createHash('sha256').update(token).digest();

export class ErrorInvitacion extends Error {}

/** Crea un enlace nuevo para un usuario que aún no activó su acceso (anula los anteriores). */
export async function nuevoEnlace(db: Db, d: { usuarioId: string; empresaId: string; creadaPor: string }): Promise<{ token: string; expira: string }> {
  const u = (await db.query(`SELECT totp_activo FROM usuarios WHERE id = $1`, [d.usuarioId])).rows[0];
  if (!u) throw new ErrorInvitacion('Usuario no encontrado.');
  if (u.totp_activo) throw new ErrorInvitacion('Ese usuario ya activó su acceso. Si olvidó su contraseña, que use "¿Olvidaste tu contraseña?".');
  const token = randomBytes(32).toString('base64url');
  const r = await enTransaccion(db, async (tx) => {
    await tx.query(`UPDATE invitaciones SET anulada_en = now() WHERE usuario_id = $1 AND usada_en IS NULL AND anulada_en IS NULL`, [d.usuarioId]);
    return tx.query(
      `INSERT INTO invitaciones (usuario_id, empresa_id, token_hash, creada_por, expira_en) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
       RETURNING expira_en`,
      [d.usuarioId, d.empresaId, huella(token), d.creadaPor, HORAS_INVITACION],
    );
  });
  return { token, expira: new Date(r.rows[0].expira_en).toISOString() };
}

/**
 * Invita a una persona a una empresa. Si ya tiene cuenta, solo se le da acceso (no hace falta
 * enlace). Si es nueva, se crea sin contraseña y se devuelve el enlace.
 */
export async function invitar(
  db: Db,
  d: { email: string; nombre: string; empresaId: string; rol: Rol; creadaPor: string },
): Promise<{ existente: true } | { existente: false; usuarioId: string; token: string; expira: string }> {
  const email = d.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErrorInvitacion('Correo inválido.');
  if (!d.nombre.trim()) throw new ErrorInvitacion('Escribe el nombre de la persona.');
  const existente = (await db.query(`SELECT id, totp_activo FROM usuarios WHERE lower(email) = $1`, [email])).rows[0];
  if (existente?.totp_activo) {
    await asignarEmpresa(db, existente.id as string, d.empresaId, d.rol);
    return { existente: true };
  }
  // Una cuenta sin activar de OTRA empresa no se puede reclamar desde aquí: quien recibe el
  // enlace tendría también el acceso a esa otra empresa.
  if (existente && (await db.query(`SELECT 1 FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id <> $2`, [existente.id, d.empresaId])).rowCount) {
    throw new ErrorInvitacion('Ese correo tiene una invitación pendiente en otra empresa: que primero la acepte, y luego invítalo de nuevo.');
  }
  const usuarioId = existente
    ? (existente.id as string)
    : ((await db.query(`INSERT INTO usuarios (email, nombre) VALUES ($1, $2) RETURNING id`, [email, d.nombre.trim()])).rows[0].id as string);
  await asignarEmpresa(db, usuarioId, d.empresaId, d.rol);
  await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'INVITAR_USUARIO', 'usuarios', $3, $4)`, [
    d.empresaId, d.creadaPor, usuarioId, JSON.stringify({ email, rol: d.rol }),
  ]);
  return { existente: false, usuarioId, ...(await nuevoEnlace(db, { usuarioId, empresaId: d.empresaId, creadaPor: d.creadaPor })) };
}

interface Vigente { invitacionId: string; usuarioId: string; email: string; nombre: string; empresa: string; rol: string }

async function vigente(db: Db, token: string): Promise<Vigente | undefined> {
  if (!token || token.length > 100) return undefined;
  const f = (await db.query(
    `SELECT i.id, u.id AS usuario_id, u.email, u.nombre, e.razon_social, ue.rol::text AS rol
       FROM invitaciones i JOIN usuarios u ON u.id = i.usuario_id JOIN empresas e ON e.id = i.empresa_id
       JOIN usuario_empresa ue ON ue.usuario_id = u.id AND ue.empresa_id = e.id
      WHERE i.token_hash = $1 AND i.usada_en IS NULL AND i.anulada_en IS NULL AND i.expira_en > now() AND u.activo AND NOT u.totp_activo`,
    [huella(token)],
  )).rows[0];
  return f ? { invitacionId: f.id, usuarioId: f.usuario_id, email: f.email, nombre: f.nombre, empresa: f.razon_social, rol: f.rol } : undefined;
}

/** Datos para mostrar al abrir el enlace (no lo gasta). */
export async function verInvitacion(db: Db, token: string): Promise<Omit<Vigente, 'invitacionId' | 'usuarioId'> | undefined> {
  const v = await vigente(db, token);
  return v ? { email: v.email, nombre: v.nombre, empresa: v.empresa, rol: v.rol } : undefined;
}

/** Paso 2: pone la contraseña y entrega un secreto nuevo para la app (aún sin activar). */
export async function aceptarInvitacion(db: Db, d: { token: string; contrasena: string; llaveMaestra: Buffer }): Promise<{ email: string; secreto: Buffer } | undefined> {
  const v = await vigente(db, d.token);
  if (!v) return undefined;
  const hash = await hashContrasena(d.contrasena);
  await db.query(`UPDATE usuarios SET password_hash = $2 WHERE id = $1`, [v.usuarioId, hash]);
  return { email: v.email, secreto: await nuevoSecretoTotp(db, v.usuarioId, d.llaveMaestra) };
}

/** Paso 3: confirma el código de la app, gasta el enlace y entrega los códigos de respaldo. */
export async function activarInvitacion(db: Db, d: { token: string; codigo: string; llaveMaestra: Buffer }): Promise<{ email: string; codigos: string[] } | 'ENLACE' | 'CODIGO'> {
  const v = await vigente(db, d.token);
  if (!v) return 'ENLACE';
  if (!(await activarTotp(db, v.usuarioId, d.codigo, d.llaveMaestra))) return 'CODIGO';
  await db.query(`UPDATE invitaciones SET usada_en = now() WHERE id = $1`, [v.invitacionId]);
  await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id) VALUES ($1, 'ACEPTAR_INVITACION', 'usuarios', $1)`, [v.usuarioId]);
  return { email: v.email, codigos: await nuevosCodigosRespaldo(db, v.usuarioId) };
}
