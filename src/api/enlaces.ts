/**
 * Enlaces para que el CLIENTE vea su comprobante sin llave de API (la tienda lo muestra en
 * el seguimiento del pedido; el dueño lo manda por WhatsApp).
 *
 *   /c/<id>.<vence>.<firma>
 *
 * La firma es un HMAC-SHA256 con una clave derivada de la LLAVE_MAESTRA: nadie puede
 * fabricar un enlace a otro comprobante ni alargar su vigencia sin esa llave. Vence al año.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const VIGENCIA_DIAS = 365;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Clave propia para los enlaces: si alguna vez se filtrara, no sirve para descifrar nada.
 * Cada uso tiene su clave, así un enlace de cotización no abre un comprobante (ni al revés).
 */
type Uso = 'comprobante' | 'cotizacion';
function claveEnlaces(llaveMaestra: Buffer, uso: Uso): Buffer {
  return Buffer.from(hkdfSync('sha256', llaveMaestra, Buffer.alloc(0), `enlaces-${uso}-v1`, 32));
}

function firma(llaveMaestra: Buffer, uso: Uso, id: string, vence: string): string {
  return createHmac('sha256', claveEnlaces(llaveMaestra, uso)).update(`${id}.${vence}`).digest('base64url');
}

function crear(llaveMaestra: Buffer, uso: Uso, id: string, ahora: Date): string {
  const vence = Math.floor(ahora.getTime() / 1000 + VIGENCIA_DIAS * 86_400).toString(36);
  return `${id}.${vence}.${firma(llaveMaestra, uso, id, vence)}`;
}

/** Id si el token es auténtico y está vigente; si no, undefined (sin decir por qué). */
function leer(llaveMaestra: Buffer, uso: Uso, token: string, ahora: Date): string | undefined {
  const [id, vence, recibida, ...resto] = token.split('.');
  if (!id || !vence || !recibida || resto.length || !UUID.test(id) || !/^[0-9a-z]{1,12}$/.test(vence)) return undefined;
  const esperada = Buffer.from(firma(llaveMaestra, uso, id, vence));
  const dada = Buffer.from(recibida);
  if (dada.length !== esperada.length || !timingSafeEqual(dada, esperada)) return undefined;
  if (parseInt(vence, 36) * 1000 < ahora.getTime()) return undefined;
  return id;
}

export const tokenComprobante = (llaveMaestra: Buffer, id: string, ahora = new Date()) => crear(llaveMaestra, 'comprobante', id, ahora);
export const leerToken = (llaveMaestra: Buffer, token: string, ahora = new Date()) => leer(llaveMaestra, 'comprobante', token, ahora);
export const tokenCotizacion = (llaveMaestra: Buffer, id: string, ahora = new Date()) => crear(llaveMaestra, 'cotizacion', id, ahora);
export const leerTokenCotizacion = (llaveMaestra: Buffer, token: string, ahora = new Date()) => leer(llaveMaestra, 'cotizacion', token, ahora);
