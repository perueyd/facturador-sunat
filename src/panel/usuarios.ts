/**
 * Usuarios y sesiones del panel web.
 *
 * Entrar exige TRES cosas a la vez: correo, contraseña y el código de 6 dígitos de la app
 * autenticadora. Cualquier fallo responde lo mismo ("datos incorrectos") para no revelar
 * cuál de las tres falló ni si el correo existe. Tras 5 fallos seguidos, la cuenta queda
 * bloqueada 15 minutos.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/conexion.js';
import { cifrar, descifrar } from '../seguridad/cifrado.js';
import { hashContrasena, verificarContrasena } from '../seguridad/contrasenas.js';
import { generarSecretoTotp, verificarTotp } from '../seguridad/totp.js';
import { MODULOS, type Modulo } from '../reportes/tablero.js';

export const ROLES = ['DUENO', 'ADMIN', 'VENDEDOR', 'CONTADOR', 'SOLO_LECTURA'] as const;
export type Rol = (typeof ROLES)[number];
/** Quiénes pueden emitir comprobantes desde el panel. */
export const ROLES_EMISORES: readonly Rol[] = ['DUENO', 'ADMIN', 'VENDEDOR'];

const INTENTOS_MAXIMOS = 5;
const BLOQUEO_MINUTOS = 15;
const SESION_HORAS = 12;
const contextoTotp = (usuarioId: string) => `totp:${usuarioId}`;
const huella = (token: string) => createHash('sha256').update(token).digest();

/** Crea el usuario (sin 2FA activo todavía). Devuelve el secreto para mostrarlo como QR. */
export async function crearUsuario(
  db: Db,
  d: { email: string; nombre: string; contrasena: string; llaveMaestra: Buffer },
): Promise<{ usuarioId: string; secreto: Buffer }> {
  const email = d.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Correo inválido.');
  const hash = await hashContrasena(d.contrasena);
  const r = await db.query(`INSERT INTO usuarios (email, nombre, password_hash) VALUES ($1, $2, $3) RETURNING id`, [email, d.nombre.trim(), hash]);
  const usuarioId = r.rows[0].id as string;
  const secreto = await nuevoSecretoTotp(db, usuarioId, d.llaveMaestra);
  return { usuarioId, secreto };
}

/** Secreto TOTP nuevo (al crear o al restablecer): queda inactivo hasta confirmarlo con un código. */
export async function nuevoSecretoTotp(db: Db, usuarioId: string, llaveMaestra: Buffer): Promise<Buffer> {
  const secreto = generarSecretoTotp();
  await db.query(
    `UPDATE usuarios SET totp_secreto_cifrado = $2, totp_activo = false, totp_ultimo_paso = NULL WHERE id = $1`,
    [usuarioId, cifrar(secreto, llaveMaestra, contextoTotp(usuarioId))],
  );
  return secreto;
}

/** Activa el segundo paso cuando el usuario demuestra que su app genera bien los códigos. */
export async function activarTotp(db: Db, usuarioId: string, codigo: string, llaveMaestra: Buffer): Promise<boolean> {
  const r = await db.query(`SELECT totp_secreto_cifrado FROM usuarios WHERE id = $1`, [usuarioId]);
  const cifrado = r.rows[0]?.totp_secreto_cifrado as Buffer | undefined;
  if (!cifrado) return false;
  const paso = verificarTotp(descifrar(cifrado, llaveMaestra, contextoTotp(usuarioId)), codigo);
  if (paso === undefined) return false;
  await db.query(`UPDATE usuarios SET totp_activo = true, totp_ultimo_paso = $2 WHERE id = $1`, [usuarioId, paso]);
  return true;
}

export async function asignarEmpresa(db: Db, usuarioId: string, empresaId: string, rol: Rol): Promise<void> {
  await db.query(
    `INSERT INTO usuario_empresa (usuario_id, empresa_id, rol) VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, empresa_id) DO UPDATE SET rol = EXCLUDED.rol`,
    [usuarioId, empresaId, rol],
  );
}

export type ResultadoEntrar = { ok: true; token: string; expira: Date } | { ok: false; bloqueado: boolean };

export async function entrar(
  db: Db,
  d: { email: string; contrasena: string; codigo: string; llaveMaestra: Buffer; ip?: string; ahora?: number },
): Promise<ResultadoEntrar> {
  const ahora = d.ahora ?? Date.now();
  const r = await db.query(
    `SELECT id, password_hash, totp_secreto_cifrado, totp_activo, totp_ultimo_paso, intentos_fallidos, bloqueado_hasta, activo
       FROM usuarios WHERE lower(email) = lower($1)`,
    [d.email.trim()],
  );
  const u = r.rows[0];
  // Se verifica la contraseña aunque el usuario no exista: mismo tiempo de respuesta.
  const contrasenaOk = await verificarContrasena(d.contrasena, u?.password_hash);
  if (!u) return { ok: false, bloqueado: false };
  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta).getTime() > ahora) return { ok: false, bloqueado: true };

  let paso: number | undefined;
  if (contrasenaOk && u.activo && u.totp_activo && u.totp_secreto_cifrado) {
    const secreto = descifrar(u.totp_secreto_cifrado as Buffer, d.llaveMaestra, contextoTotp(u.id as string));
    paso = verificarTotp(secreto, d.codigo, { ahora, ultimoPaso: u.totp_ultimo_paso === null ? null : Number(u.totp_ultimo_paso) });
  }
  // El código se "gasta" en la misma orden que lo comprueba: si dos entradas llegan a la vez
  // con el mismo código, solo una lo consigue.
  if (paso !== undefined) {
    const gastado = await db.query(
      `UPDATE usuarios SET totp_ultimo_paso = $2 WHERE id = $1 AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < $2)`,
      [u.id, paso],
    );
    if (!gastado.rowCount) paso = undefined;
  }
  if (paso === undefined) {
    // Contador atómico: intentos simultáneos no se pisan entre sí.
    const f = await db.query(
      `UPDATE usuarios SET
         bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= $2 THEN $3::timestamptz ELSE bloqueado_hasta END,
         intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= $2 THEN 0 ELSE intentos_fallidos + 1 END
       WHERE id = $1 RETURNING bloqueado_hasta`,
      [u.id, INTENTOS_MAXIMOS, new Date(ahora + BLOQUEO_MINUTOS * 60_000)],
    );
    const hasta = f.rows[0]?.bloqueado_hasta as Date | null | undefined;
    const bloquear = Boolean(hasta && new Date(hasta).getTime() > ahora);
    await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'usuarios', $1, $3)`, [
      u.id, bloquear ? 'PANEL_BLOQUEO' : 'PANEL_ENTRADA_FALLIDA', JSON.stringify({ ip: d.ip ?? null }),
    ]);
    return { ok: false, bloqueado: bloquear };
  }

  const token = randomBytes(32).toString('base64url');
  const expira = new Date(ahora + SESION_HORAS * 3_600_000);
  const empresa = await db.query(`SELECT empresa_id FROM usuario_empresa WHERE usuario_id = $1 ORDER BY creado_en LIMIT 1`, [u.id]);
  await db.query(`UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [u.id]);
  await db.query(`INSERT INTO sesiones (usuario_id, token_hash, empresa_id, ip, expira_en) VALUES ($1, $2, $3, $4, $5)`, [
    u.id, huella(token), empresa.rows[0]?.empresa_id ?? null, d.ip ?? null, expira,
  ]);
  await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'PANEL_ENTRADA', 'usuarios', $1, $2)`, [
    u.id, JSON.stringify({ ip: d.ip ?? null }),
  ]);
  return { ok: true, token, expira };
}

export interface EmpresaDelUsuario {
  id: string;
  ruc: string;
  razonSocial: string;
  rol: Rol;
  ambiente: 'BETA' | 'PRODUCCION';
  /** Funciones del panel que esta empresa tiene activas. */
  modulos: Modulo[];
}

export interface Sesion {
  sesionId: string;
  usuarioId: string;
  nombre: string;
  email: string;
  /** Puede dar de alta empresas nuevas (lo activa el dueño de la plataforma por comando). */
  adminPlataforma: boolean;
  empresas: EmpresaDelUsuario[];
  /** Empresa elegida, siempre una a la que el usuario tiene acceso (o undefined si no tiene ninguna). */
  empresa: EmpresaDelUsuario | undefined;
}

/** Sesión vigente del token, o undefined (vencida, revocada, usuario desactivado o bloqueado). */
export async function leerSesion(db: Db, token: string | undefined): Promise<Sesion | undefined> {
  if (!token || token.length > 100) return undefined;
  const r = await db.query(
    `SELECT s.id, s.empresa_id, u.id AS usuario_id, u.nombre, u.email, u.admin_plataforma
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash = $1 AND s.revocada_en IS NULL AND s.expira_en > now()
        AND u.activo AND (u.bloqueado_hasta IS NULL OR u.bloqueado_hasta < now())`,
    [huella(token)],
  );
  const s = r.rows[0];
  if (!s) return undefined;
  const e = await db.query(
    `SELECT e.id, e.ruc, e.razon_social, ue.rol::text AS rol, e.ambiente_sunat::text AS ambiente, e.modulos_desactivados
       FROM usuario_empresa ue JOIN empresas e ON e.id = ue.empresa_id
      WHERE ue.usuario_id = $1 AND NOT ('panel' = ANY(e.modulos_desactivados)) ORDER BY e.razon_social`,
    [s.usuario_id],
  );
  // Una empresa con el panel desactivado ni aparece: se maneja solo por API.
  const empresas: EmpresaDelUsuario[] = e.rows.map((x) => ({
    id: x.id, ruc: x.ruc, razonSocial: x.razon_social, rol: x.rol, ambiente: x.ambiente,
    modulos: MODULOS.filter((m) => !(x.modulos_desactivados as string[]).includes(m)),
  }));
  return {
    sesionId: s.id, usuarioId: s.usuario_id, nombre: s.nombre, email: s.email, adminPlataforma: s.admin_plataforma, empresas,
    // Si le quitaron el acceso a la empresa elegida, no se usa aunque siga en la sesión.
    empresa: empresas.find((x) => x.id === s.empresa_id) ?? empresas[0],
  };
}

export async function elegirEmpresa(db: Db, sesion: Sesion, empresaId: string): Promise<boolean> {
  if (!sesion.empresas.some((e) => e.id === empresaId)) return false;
  await db.query(`UPDATE sesiones SET empresa_id = $2 WHERE id = $1`, [sesion.sesionId, empresaId]);
  return true;
}

export async function salir(db: Db, token: string): Promise<void> {
  await db.query(`UPDATE sesiones SET revocada_en = now() WHERE token_hash = $1 AND revocada_en IS NULL`, [huella(token)]);
}

/** Cierra todas las sesiones de un usuario (al desactivarlo o restablecer su 2FA). */
export async function cerrarSesionesDe(db: Db, usuarioId: string): Promise<void> {
  await db.query(`UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND revocada_en IS NULL`, [usuarioId]);
}

/** Cambiar la contraseña desde el panel: exige la actual y un código de 6 dígitos nuevo. */
export async function cambiarContrasena(
  db: Db,
  d: { usuarioId: string; sesionId: string; actual: string; nueva: string; codigo: string; llaveMaestra: Buffer },
): Promise<{ ok: true } | { ok: false; mensaje: string }> {
  const r = await db.query(`SELECT password_hash, totp_secreto_cifrado, totp_ultimo_paso FROM usuarios WHERE id = $1`, [d.usuarioId]);
  const u = r.rows[0];
  if (!u || !(await verificarContrasena(d.actual, u.password_hash))) return { ok: false, mensaje: 'La contraseña actual no es correcta.' };
  const secreto = descifrar(u.totp_secreto_cifrado as Buffer, d.llaveMaestra, contextoTotp(d.usuarioId));
  const paso = verificarTotp(secreto, d.codigo, { ultimoPaso: u.totp_ultimo_paso === null ? null : Number(u.totp_ultimo_paso) });
  if (paso === undefined) return { ok: false, mensaje: 'El código de 6 dígitos no es correcto o ya se usó. Espera el siguiente.' };
  let hash: string;
  try {
    hash = await hashContrasena(d.nueva);
  } catch (e) {
    return { ok: false, mensaje: e instanceof Error ? e.message : 'Contraseña inválida.' };
  }
  const cambio = await db.query(
    `UPDATE usuarios SET password_hash = $2, totp_ultimo_paso = $3 WHERE id = $1 AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < $3)`,
    [d.usuarioId, hash, paso],
  );
  if (!cambio.rowCount) return { ok: false, mensaje: 'El código ya se usó. Espera el siguiente.' };
  // Las demás sesiones (otro celular, otra computadora) se cierran; esta sigue.
  await db.query(`UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND id <> $2 AND revocada_en IS NULL`, [d.usuarioId, d.sesionId]);
  await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id) VALUES ($1, 'PANEL_CAMBIO_CONTRASENA', 'usuarios', $1)`, [d.usuarioId]);
  return { ok: true };
}
