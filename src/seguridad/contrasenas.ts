/**
 * Contraseñas del panel: se guardan con scrypt (lento a propósito, con sal propia), nunca
 * en claro. Formato: scrypt$N$r$p$sal$huella (base64), para poder subir el costo después.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const LARGO = 32;
export const CONTRASENA_MINIMA = 10;

function derivar(contrasena: string, sal: Buffer, o: ScryptOptions): Promise<Buffer> {
  return new Promise((ok, falla) => {
    scrypt(contrasena.normalize('NFC'), sal, LARGO, { ...o, maxmem: 64 * 1024 * 1024 }, (e, h) => (e ? falla(e) : ok(h)));
  });
}

export async function hashContrasena(contrasena: string): Promise<string> {
  if (contrasena.length < CONTRASENA_MINIMA) throw new Error(`La contraseña debe tener al menos ${CONTRASENA_MINIMA} caracteres.`);
  const sal = randomBytes(16);
  const h = await derivar(contrasena, sal, { N, r: R, p: P });
  return ['scrypt', N, R, P, sal.toString('base64'), h.toString('base64')].join('$');
}

export async function verificarContrasena(contrasena: string, guardado: string | null | undefined): Promise<boolean> {
  const partes = guardado?.split('$');
  if (!partes || partes.length !== 6 || partes[0] !== 'scrypt') {
    // Sin contraseña guardada se hace el mismo trabajo igual: así el tiempo de respuesta
    // no revela si el correo existe.
    await derivar(contrasena, Buffer.alloc(16), { N, r: R, p: P });
    return false;
  }
  const [, n, r, p, sal, huella] = partes as [string, string, string, string, string, string];
  const esperado = Buffer.from(huella, 'base64');
  const h = await derivar(contrasena, Buffer.from(sal, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return h.length === esperado.length && timingSafeEqual(h, esperado);
}
