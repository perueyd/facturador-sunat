/**
 * Usuarios del panel web (/panel).
 *
 *   npm run usuario -- crear       --email tu@correo.com --nombre "Tu nombre" --ruc 20XXXXXXXXX --rol DUENO
 *   npm run usuario -- asignar     --email tu@correo.com --ruc 10XXXXXXXXX --rol ADMIN
 *   npm run usuario -- restablecer-2fa --email tu@correo.com
 *   npm run usuario -- desactivar  --email tu@correo.com
 *   npm run usuario -- listar      --ruc 20XXXXXXXXX
 *
 * Roles: DUENO, ADMIN y VENDEDOR emiten; CONTADOR y SOLO_LECTURA solo consultan.
 * La contraseña se pide por teclado (salen asteriscos). Después aparece un código QR:
 * escanéalo con Google Authenticator o Microsoft Authenticator y escribe el código de
 * 6 dígitos que muestre para activarlo.
 */
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { crearPool, type Db } from '../src/db/conexion.js';
import { ROLES, activarTotp, asignarEmpresa, cerrarSesionesDe, crearUsuario, nuevoSecretoTotp, type Rol } from '../src/panel/usuarios.js';
import { llaveMaestraDesdeEntorno } from '../src/seguridad/cifrado.js';
import { base32, urlOtpauth } from '../src/seguridad/totp.js';
import { empresaPorRuc, pedirOculto } from './lib/consola.js';

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: { email: { type: 'string' }, nombre: { type: 'string' }, ruc: { type: 'string' }, rol: { type: 'string' } },
});
const accion = positionals[0] ?? '';

function rol(): Rol {
  const r = (v.rol ?? '').toUpperCase() as Rol;
  if (!ROLES.includes(r)) throw new Error(`Indica --rol ${ROLES.join(' | ')}.`);
  return r;
}

async function usuarioPorEmail(db: Db, email: string | undefined): Promise<string> {
  const r = await db.query(`SELECT id FROM usuarios WHERE lower(email) = lower($1)`, [email ?? '']);
  if (!r.rows[0]) throw new Error(`No existe el usuario ${email}.`);
  return r.rows[0].id as string;
}

/** Muestra el QR y pide el código hasta 3 veces para activar el segundo paso. */
async function configurarApp(db: Db, usuarioId: string, email: string, secreto: Buffer, llaveMaestra: Buffer) {
  console.log('\nEscanea este código con Google Authenticator o Microsoft Authenticator:\n');
  console.log(await QRCode.toString(urlOtpauth(email, secreto), { type: 'terminal', small: true }));
  console.log(`Si no puedes escanearlo, en la app elige "Ingresar clave" y escribe: ${base32(secreto)}\n`);
  for (let intento = 1; intento <= 3; intento++) {
    const codigo = (await pedirOculto('Código de 6 dígitos que muestra la app: ')).trim();
    if (await activarTotp(db, usuarioId, codigo, llaveMaestra)) {
      console.log('✔ Verificación en dos pasos activada. Ya puedes entrar al panel: la dirección de Render + /panel');
      return;
    }
    console.log('✘ Ese código no coincide. Revisa que la hora del celular esté en automático.');
  }
  throw new Error('No se activó el segundo paso. Repite con: npm run usuario -- restablecer-2fa --email ' + email);
}

const db = crearPool();
try {
  const llaveMaestra = llaveMaestraDesdeEntorno();
  if (accion === 'crear') {
    if (!v.email || !v.nombre || !v.ruc) throw new Error('Uso: npm run usuario -- crear --email … --nombre "…" --ruc … --rol DUENO');
    const r = rol();
    const empresa = await empresaPorRuc(db, v.ruc);
    const contrasena = await pedirOculto('Contraseña nueva (mínimo 10 caracteres): ');
    if ((await pedirOculto('Repite la contraseña: ')) !== contrasena) throw new Error('Las contraseñas no coinciden.');
    const { usuarioId, secreto } = await crearUsuario(db, { email: v.email, nombre: v.nombre, contrasena, llaveMaestra });
    await asignarEmpresa(db, usuarioId, empresa.id, r);
    console.log(`✔ Usuario ${v.email} creado (rol ${r}, empresa ${empresa.razonSocial})`);
    await configurarApp(db, usuarioId, v.email, secreto, llaveMaestra);
  } else if (accion === 'asignar') {
    const empresa = await empresaPorRuc(db, v.ruc);
    await asignarEmpresa(db, await usuarioPorEmail(db, v.email), empresa.id, rol());
    console.log(`✔ ${v.email} ahora tiene rol ${rol()} (empresa ${empresa.razonSocial})`);
  } else if (accion === 'restablecer-2fa') {
    const usuarioId = await usuarioPorEmail(db, v.email);
    const secreto = await nuevoSecretoTotp(db, usuarioId, llaveMaestra);
    await cerrarSesionesDe(db, usuarioId);
    console.log('Se cerraron todas sus sesiones. El código anterior ya no sirve.');
    await configurarApp(db, usuarioId, v.email!, secreto, llaveMaestra);
  } else if (accion === 'desactivar') {
    const usuarioId = await usuarioPorEmail(db, v.email);
    await db.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [usuarioId]);
    await cerrarSesionesDe(db, usuarioId);
    console.log(`✔ ${v.email} desactivado; sus sesiones se cerraron.`);
  } else if (accion === 'listar') {
    const empresa = await empresaPorRuc(db, v.ruc);
    const r = await db.query(
      `SELECT u.email, u.nombre, ue.rol::text AS rol, u.activo, u.totp_activo FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id
        WHERE ue.empresa_id = $1 ORDER BY u.email`,
      [empresa.id],
    );
    console.table(r.rows.map((x) => ({ correo: x.email, nombre: x.nombre, rol: x.rol, estado: x.activo ? 'ACTIVO' : 'DESACTIVADO', dosPasos: x.totp_activo ? 'sí' : 'NO' })));
  } else {
    throw new Error('Acción: crear | asignar | restablecer-2fa | desactivar | listar (ver el encabezado de scripts/usuario.ts).');
  }
} catch (e) {
  console.error('✘', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
