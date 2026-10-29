/**
 * Usuarios y sesiones del panel web.
 *
 * Entrar exige TRES cosas a la vez: correo, contraseña y el código de 6 dígitos de la app
 * autenticadora. Cualquier fallo responde lo mismo ("datos incorrectos") para no revelar
 * cuál de las tres falló ni si el correo existe. Tras 5 fallos seguidos, la cuenta queda
 * bloqueada 15 minutos.
 *
 * Si se pierde el celular, un código de respaldo (de un solo uso) reemplaza al de la app.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { enTransaccion, type Db, type Tx } from '../db/conexion.js';
import { cifrar, descifrar } from '../seguridad/cifrado.js';
import { hashContrasena, verificarContrasena } from '../seguridad/contrasenas.js';
import { generarSecretoTotp, verificarTotp } from '../seguridad/totp.js';
import { MODULOS, SECCIONES_DE_PLAN, type Modulo } from '../reportes/tablero.js';

export const ROLES = ['DUENO', 'ADMIN', 'VENDEDOR', 'CONTADOR', 'SOLO_LECTURA'] as const;
export type Rol = (typeof ROLES)[number];
/** Quiénes pueden emitir comprobantes desde el panel. */
export const ROLES_EMISORES: readonly Rol[] = ['DUENO', 'ADMIN', 'VENDEDOR'];

const INTENTOS_MAXIMOS = 5;
const BLOQUEO_MINUTOS = 15;
const SESION_HORAS = 12;
/** "Mantener mi sesión iniciada": en un dispositivo propio no se vuelve a pedir entrar por 30 días. */
const SESION_RECORDADA_DIAS = 30;
const contextoTotp = (usuarioId: string) => `totp:${usuarioId}`;
const huella = (token: string) => createHash('sha256').update(token).digest();

// ---------- Códigos de respaldo ----------
const CODIGOS_RESPALDO = 10;
/** Sin 0/O ni 1/I: se copian a mano de un papel sin confundirse. */
const ALFABETO_RESPALDO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalizarRespaldo = (codigo: string) => codigo.toUpperCase().replace(/[^A-Z0-9]/g, '');
const huellaRespaldo = (usuarioId: string, codigo: string) =>
  createHash('sha256').update(`${usuarioId}:${normalizarRespaldo(codigo)}`).digest();
/** Un código de respaldo tiene 10 letras/números (ej. "K7QM2-XW9RP"); el de la app, 6 dígitos. */
const esCodigoRespaldo = (codigo: string) => normalizarRespaldo(codigo).length === 10;

/** Genera códigos nuevos (los anteriores sin usar dejan de servir). Se muestran UNA vez. */
export async function nuevosCodigosRespaldo(db: Db | Tx, usuarioId: string): Promise<string[]> {
  const codigos = Array.from({ length: CODIGOS_RESPALDO }, () => {
    const t = Array.from({ length: 10 }, () => ALFABETO_RESPALDO[randomInt(ALFABETO_RESPALDO.length)]).join('');
    return `${t.slice(0, 5)}-${t.slice(5)}`;
  });
  await db.query(`UPDATE codigos_respaldo SET anulado_en = now() WHERE usuario_id = $1 AND usado_en IS NULL AND anulado_en IS NULL`, [usuarioId]);
  await db.query(`INSERT INTO codigos_respaldo (usuario_id, hash) SELECT $1, unnest($2::bytea[])`, [usuarioId, codigos.map((c) => huellaRespaldo(usuarioId, c))]);
  await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id) VALUES ($1, 'CODIGOS_RESPALDO', 'usuarios', $1)`, [usuarioId]);
  return codigos;
}

export async function codigosRespaldoRestantes(db: Db, usuarioId: string): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM codigos_respaldo WHERE usuario_id = $1 AND usado_en IS NULL AND anulado_en IS NULL`, [usuarioId]);
  return r.rows[0].n as number;
}

/**
 * Comprueba el segundo paso (código de la app O código de respaldo) y lo GASTA en la misma
 * orden: ese código ya no vuelve a servir, ni aunque dos pedidos lleguen a la vez.
 */
async function gastarSegundoPaso(
  db: Db | Tx,
  u: { id: string; totp_secreto_cifrado: Buffer | null; totp_ultimo_paso: unknown },
  codigo: string,
  llaveMaestra: Buffer,
  ahora = Date.now(),
): Promise<'APP' | 'RESPALDO' | undefined> {
  if (esCodigoRespaldo(codigo)) {
    const r = await db.query(
      `UPDATE codigos_respaldo SET usado_en = now() WHERE usuario_id = $1 AND hash = $2 AND usado_en IS NULL AND anulado_en IS NULL RETURNING id`,
      [u.id, huellaRespaldo(u.id, codigo)],
    );
    return r.rowCount ? 'RESPALDO' : undefined;
  }
  if (!u.totp_secreto_cifrado) return undefined;
  const secreto = descifrar(u.totp_secreto_cifrado, llaveMaestra, contextoTotp(u.id));
  const paso = verificarTotp(secreto, codigo, { ahora, ultimoPaso: u.totp_ultimo_paso === null ? null : Number(u.totp_ultimo_paso) });
  if (paso === undefined) return undefined;
  const gastado = await db.query(
    `UPDATE usuarios SET totp_ultimo_paso = $2 WHERE id = $1 AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < $2)`,
    [u.id, paso],
  );
  return gastado.rowCount ? 'APP' : undefined;
}

/** Crea el usuario (sin 2FA activo todavía). Devuelve el secreto para mostrarlo como QR. */
export async function crearUsuario(
  db: Db | Tx,
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
export async function nuevoSecretoTotp(db: Db | Tx, usuarioId: string, llaveMaestra: Buffer): Promise<Buffer> {
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

export async function asignarEmpresa(db: Db | Tx, usuarioId: string, empresaId: string, rol: Rol): Promise<void> {
  await db.query(
    `INSERT INTO usuario_empresa (usuario_id, empresa_id, rol) VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, empresa_id) DO UPDATE SET rol = EXCLUDED.rol`,
    [usuarioId, empresaId, rol],
  );
}

export type ResultadoEntrar = { ok: true; token: string; expira: Date } | { ok: false; bloqueado: boolean };

export async function entrar(
  db: Db,
  d: { email: string; contrasena: string; codigo: string; llaveMaestra: Buffer; ip?: string; ahora?: number; recordar?: boolean },
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

  const segundoPaso = contrasenaOk && u.activo && u.totp_activo ? await gastarSegundoPaso(db, u, d.codigo, d.llaveMaestra, ahora) : undefined;
  if (segundoPaso === undefined) {
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
  const expira = new Date(ahora + (d.recordar ? SESION_RECORDADA_DIAS * 24 : SESION_HORAS) * 3_600_000);
  const empresa = await db.query(`SELECT empresa_id FROM usuario_empresa WHERE usuario_id = $1 ORDER BY creado_en LIMIT 1`, [u.id]);
  await db.query(`UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [u.id]);
  await db.query(`INSERT INTO sesiones (usuario_id, token_hash, empresa_id, ip, expira_en) VALUES ($1, $2, $3, $4, $5)`, [
    u.id, huella(token), empresa.rows[0]?.empresa_id ?? null, d.ip ?? null, expira,
  ]);
  await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'PANEL_ENTRADA', 'usuarios', $1, $2)`, [
    u.id, JSON.stringify({ ip: d.ip ?? null, ...(segundoPaso === 'RESPALDO' ? { codigoRespaldo: true } : {}) }),
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
  /** Secciones que su plan no incluye (para ofrecer el plan que las trae). */
  bloqueadas: Modulo[];
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
    `SELECT e.id, e.ruc, e.razon_social, ue.rol::text AS rol, e.ambiente_sunat::text AS ambiente, e.modulos_desactivados,
            p.secciones AS secciones_plan
       FROM usuario_empresa ue JOIN empresas e ON e.id = ue.empresa_id
       LEFT JOIN suscripciones su ON su.empresa_id = e.id LEFT JOIN planes p ON p.codigo = su.plan_codigo
      WHERE ue.usuario_id = $1 AND NOT ('panel' = ANY(e.modulos_desactivados)) ORDER BY e.razon_social`,
    [s.usuario_id],
  );
  // Una empresa con el panel desactivado ni aparece: se maneja solo por API.
  // Activa = no desactivada por la empresa Y (si tiene plan) incluida en su plan.
  const empresas: EmpresaDelUsuario[] = e.rows.map((x) => {
    const delPlan = x.secciones_plan as string[] | null;
    const fueraDelPlan = (m: Modulo) => delPlan !== null && (SECCIONES_DE_PLAN as readonly Modulo[]).includes(m) && !delPlan.includes(m);
    return {
      id: x.id, ruc: x.ruc, razonSocial: x.razon_social, rol: x.rol, ambiente: x.ambiente,
      modulos: MODULOS.filter((m) => !(x.modulos_desactivados as string[]).includes(m) && !fueraDelPlan(m)),
      bloqueadas: MODULOS.filter(fueraDelPlan),
    };
  });
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

/**
 * Recuperar el acceso: contraseña nueva y segundo paso nuevo (queda inactivo hasta confirmar
 * el código). Cierra todas las sesiones y quita el bloqueo por intentos.
 */
export async function restablecerAcceso(
  db: Db,
  d: { usuarioId: string; contrasena: string; llaveMaestra: Buffer; motivo: string },
): Promise<Buffer> {
  const hash = await hashContrasena(d.contrasena);
  return enTransaccion(db, async (tx) => {
    await tx.query(`UPDATE usuarios SET password_hash = $2, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [d.usuarioId, hash]);
    const secreto = await nuevoSecretoTotp(tx, d.usuarioId, d.llaveMaestra);
    await tx.query(`UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND revocada_en IS NULL`, [d.usuarioId]);
    await tx.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'RESTABLECER_ACCESO', 'usuarios', $1, $2)`, [
      d.usuarioId, JSON.stringify({ motivo: d.motivo }),
    ]);
    return secreto;
  });
}

/** Cierra las demás sesiones del usuario (otro celular, una computadora prestada); esta sigue. */
export async function cerrarOtrasSesiones(db: Db, sesion: { usuarioId: string; sesionId: string }): Promise<number> {
  const r = await db.query(`UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND id <> $2 AND revocada_en IS NULL AND expira_en > now()`, [
    sesion.usuarioId, sesion.sesionId,
  ]);
  return r.rowCount ?? 0;
}

/** Generar códigos de respaldo nuevos desde el panel: exige un código de la app (o uno de respaldo). */
export async function regenerarCodigosRespaldo(db: Db, d: { usuarioId: string; codigo: string; llaveMaestra: Buffer }): Promise<string[] | undefined> {
  const u = (await db.query(`SELECT id, totp_secreto_cifrado, totp_ultimo_paso FROM usuarios WHERE id = $1 AND totp_activo`, [d.usuarioId])).rows[0];
  if (!u || !(await gastarSegundoPaso(db, u, d.codigo, d.llaveMaestra))) return undefined;
  return nuevosCodigosRespaldo(db, d.usuarioId);
}

// ---------- Recuperar la contraseña por correo ----------
const ENLACE_MINUTOS = 30;
/** Entre un enlace y otro al mismo usuario: evita llenarle el correo. */
const ENLACE_ESPERA_MINUTOS = 2;

/**
 * Enlace para cambiar la contraseña olvidada. Devuelve undefined si el correo no tiene usuario
 * activo (quien llama responde igual en los dos casos, para no revelar qué correos existen).
 */
export async function crearEnlaceRecuperacion(db: Db, d: { email: string; ip?: string }): Promise<{ token: string; email: string } | undefined> {
  const u = (await db.query(`SELECT id, email FROM usuarios WHERE lower(email) = lower($1) AND activo AND totp_activo`, [d.email.trim()])).rows[0];
  if (!u) return undefined;
  const reciente = await db.query(
    `SELECT 1 FROM recuperaciones_correo WHERE usuario_id = $1 AND creado_en > now() - make_interval(mins => $2)`, [u.id, ENLACE_ESPERA_MINUTOS],
  );
  if (reciente.rowCount) return undefined;
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO recuperaciones_correo (usuario_id, token_hash, ip, expira_en) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [u.id, huella(token), d.ip ?? null, ENLACE_MINUTOS],
  );
  await db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'ENLACE_RECUPERACION', 'usuarios', $1, $2)`, [
    u.id, JSON.stringify({ ip: d.ip ?? null }),
  ]);
  return { token, email: u.email as string };
}

/**
 * Contraseña nueva con el enlace del correo. Pide además el segundo paso (app o respaldo):
 * quien robe el correo no basta para entrar. Cierra todas las sesiones.
 */
export async function recuperarConEnlace(
  db: Db,
  d: { token: string; contrasena: string; codigo: string; llaveMaestra: Buffer },
): Promise<{ ok: true; email: string } | { ok: false; motivo: 'ENLACE' | 'CODIGO' | 'CONTRASENA'; mensaje: string }> {
  if (!d.token || d.token.length > 100) return { ok: false, motivo: 'ENLACE', mensaje: 'El enlace no es válido.' };
  const r = await db.query(
    `SELECT r.id AS recuperacion_id, u.id, u.email, u.totp_secreto_cifrado, u.totp_ultimo_paso
       FROM recuperaciones_correo r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.token_hash = $1 AND r.usado_en IS NULL AND r.expira_en > now() AND u.activo AND u.totp_activo`,
    [huella(d.token)],
  );
  const u = r.rows[0];
  if (!u) return { ok: false, motivo: 'ENLACE', mensaje: 'El enlace venció o ya se usó. Pide otro desde "¿Olvidaste tu contraseña?".' };
  let hash: string;
  try {
    hash = await hashContrasena(d.contrasena);
  } catch (e) {
    return { ok: false, motivo: 'CONTRASENA', mensaje: e instanceof Error ? e.message : 'Contraseña inválida.' };
  }
  return enTransaccion(db, async (tx) => {
    if (!(await gastarSegundoPaso(tx, u, d.codigo, d.llaveMaestra))) {
      return { ok: false as const, motivo: 'CODIGO' as const, mensaje: 'El código no es correcto o ya se usó. Usa el de tu app o uno de tus códigos de respaldo.' };
    }
    const usado = await tx.query(`UPDATE recuperaciones_correo SET usado_en = now() WHERE id = $1 AND usado_en IS NULL RETURNING id`, [u.recuperacion_id]);
    if (!usado.rowCount) return { ok: false as const, motivo: 'ENLACE' as const, mensaje: 'El enlace ya se usó.' };
    await tx.query(`UPDATE usuarios SET password_hash = $2, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1`, [u.id, hash]);
    await tx.query(`UPDATE sesiones SET revocada_en = now() WHERE usuario_id = $1 AND revocada_en IS NULL`, [u.id]);
    await tx.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'RESTABLECER_ACCESO', 'usuarios', $1, $2)`, [
      u.id, JSON.stringify({ motivo: 'enlace por correo' }),
    ]);
    return { ok: true as const, email: u.email as string };
  });
}
