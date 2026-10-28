/**
 * Servidor HTTP de la API.   npm run servidor
 * Variables: DATABASE_URL, LLAVE_MAESTRA, FIRMA_ALGORITMO, CLAVE_CRON, PUERTO (o PORT), opcionales
 * RESEND_API_KEY + AVISOS_DESDE (avisos por correo) y, solo
 * en desarrollo, ALMACEN_DIR. Ver docs/PUBLICAR.md.
 */
import { serve } from '@hono/node-server';
import { crearApp } from './api/app.js';
import { correoResend } from './avisos/avisos.js';
import { serviciosDesdeEntorno } from './config.js';
import { crearPool } from './db/conexion.js';

const db = crearPool();
// Al emitir, la tienda espera la respuesta: el intento inmediato a SUNAT se corta a los 8 s
// y, si no alcanza, sigue en la cola.
const app = crearApp({
  db,
  servicios: serviciosDesdeEntorno(db, process.env, { tiempoMaximoSunatMs: 8_000 }),
  ...(process.env.CLAVE_CRON ? { claveCron: process.env.CLAVE_CRON } : {}),
  // Primera configuración del panel desde el celular (solo sirve mientras no exista ningún usuario).
  ...(process.env.CLAVE_INSTALACION ? { claveInstalacion: process.env.CLAVE_INSTALACION } : {}),
  // Avisos por correo: solo si están las dos variables (ver docs/PUBLICAR.md, paso 8).
  ...(process.env.RESEND_API_KEY && process.env.AVISOS_DESDE ? { correo: correoResend(process.env.RESEND_API_KEY, process.env.AVISOS_DESDE) } : {}),
});
// PORT es el nombre que usan Render y Railway al publicar.
const puerto = Number(process.env.PUERTO ?? process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port: puerto }, () => console.log(`Facturador escuchando en http://localhost:${puerto}`));
