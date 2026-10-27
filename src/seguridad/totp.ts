/**
 * Códigos de 6 dígitos que cambian cada 30 s (TOTP, RFC 6238), los mismos de Google
 * Authenticator o Microsoft Authenticator. Son el segundo paso del panel: la contraseña
 * sola no basta para emitir con el RUC de la empresa.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASO_SEGUNDOS = 30;

export function base32(datos: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of datos) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

/** Secreto nuevo de 160 bits (lo recomendado por el RFC 4226). */
export function generarSecretoTotp(): Buffer {
  return randomBytes(20);
}

export function pasoActual(ahora = Date.now()): number {
  return Math.floor(ahora / 1000 / PASO_SEGUNDOS);
}

export function codigoTotp(secreto: Buffer, paso: number, digitos = 6): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const h = createHmac('sha1', secreto).update(contador).digest();
  const desde = h[h.length - 1]! & 0x0f;
  const numero = (h.readUInt32BE(desde) & 0x7fffffff) % 10 ** digitos;
  return String(numero).padStart(digitos, '0');
}

/**
 * Verifica un código aceptando un paso de desfase (el reloj del celular puede ir algo
 * adelantado o atrasado). Devuelve el paso aceptado, o undefined. Si `ultimoPaso` viene,
 * no se acepta ese paso ni uno anterior: un código ya usado no vale dos veces.
 */
export function verificarTotp(secreto: Buffer, codigo: string, opciones: { ahora?: number; ultimoPaso?: number | null } = {}): number | undefined {
  if (!/^\d{6}$/.test(codigo)) return undefined;
  const actual = pasoActual(opciones.ahora);
  for (const paso of [actual - 1, actual, actual + 1]) {
    if (opciones.ultimoPaso != null && paso <= opciones.ultimoPaso) continue;
    if (timingSafeEqual(Buffer.from(codigoTotp(secreto, paso)), Buffer.from(codigo))) return paso;
  }
  return undefined;
}

/** Dirección que leen las apps autenticadoras (también se muestra como QR). */
export function urlOtpauth(cuenta: string, secreto: Buffer, emisor = 'Facturador'): string {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  return `otpauth://totp/${etiqueta}?secret=${base32(secreto)}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=${PASO_SEGUNDOS}`;
}
