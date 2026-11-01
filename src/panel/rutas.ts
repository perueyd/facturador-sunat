/**
 * Panel web del facturador (/panel): emitir boletas y facturas a mano, para ventas por
 * WhatsApp, Instagram o en persona, sin pasar por la tienda.
 *
 * Seguridad:
 *   - Entrar exige correo + contraseña + código de 6 dígitos (ver usuarios.ts).
 *   - La sesión va en una cookie HttpOnly, Secure, SameSite=Strict: el JavaScript de la
 *     página no la puede leer y otro sitio no la puede usar.
 *   - Toda orden que cambia algo exige la cabecera X-Panel: 1 (un formulario de otro sitio
 *     no puede ponerla) y, si llega Origin, que sea este mismo sitio.
 *   - Política de contenido estricta: solo se ejecuta el JavaScript propio del panel.
 *   - Cada usuario ve y emite SOLO en las empresas que tiene asignadas, según su rol.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Almacen } from '../almacen/almacen.js';
import { autenticarLlave } from '../api/llaves.js';
import { ErrorInvitacion, aceptarInvitacion, activarInvitacion, invitar, nuevoEnlace, verInvitacion } from './invitaciones.js';
import { ErrorConfiguracionSunat, guardarCredencialesSol } from '../sunat/configuracion.js';
import type { EnviarCorreo } from '../avisos/avisos.js';
import { esFormatoPdf, pdfDeComprobante } from '../comprobantes/pdf-comprobante.js';
import { enTransaccion, type Db } from '../db/conexion.js';
import { ErrorEmpresa, configurarEmpresa } from '../empresas/configurar.js';
import { ErrorLogo, guardarLogo } from '../empresas/logo.js';
import { ErrorCertificado } from '../firma/certificado.js';
import { guardarCertificado } from '../firma/repositorio-certificados.js';
import { base32, urlOtpauth } from '../seguridad/totp.js';
import { ErrorPdf } from '../pdf/representacion.js';
import { iniciarPrueba, suscripcionDe } from '../plataforma/suscripciones.js';
import { estadisticas } from '../reportes/estadisticas.js';
import { resultadoDelMes } from '../reportes/resultado.js';
import { ahoraLima } from '../fechas.js';
import { tablero, type Modulo } from '../reportes/tablero.js';
import { idComprobanteLegible } from '../tipos.js';
import QRCode from 'qrcode';
import type { Regimen } from '../tipos.js';
import {
  ROLES, ROLES_EMISORES, activarTotp, asignarEmpresa, cambiarContrasena, cerrarOtrasSesiones, codigosRespaldoRestantes, crearEnlaceRecuperacion,
  crearUsuario, elegirEmpresa, entrar, leerSesion, nuevosCodigosRespaldo, recuperarConEnlace, regenerarCodigosRespaldo, restablecerAcceso, salir,
  type Rol, type Sesion,
} from './usuarios.js';
import { ROLES_CORRIGEN, ROLES_COMPRAS, UUID, origenPropio } from './comun-rutas.js';
import { registrarCobros } from './rutas-cobros.js';
import { registrarInventario } from './rutas-inventario.js';
import { registrarPlataforma } from './rutas-plataforma.js';
import { registrarVentas } from './rutas-ventas.js';

const COOKIE = '__Host-panel';
/** Texto tal como llegó (sin recortar espacios: una contraseña puede tenerlos), con tope de largo. */
const crudo = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
/** El panel genera el número de pedido al abrir el formulario: pulsar dos veces no emite dos. */
const PEDIDO_PANEL = /^PANEL-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const leer = (archivo: string) => readFileSync(new URL(`./publico/${archivo}`, import.meta.url));
const PAGINA = { contenido: leer('index.html'), tipo: 'text/html; charset=utf-8' };
const BASE = {
  'app.js': { contenido: leer('app.js'), tipo: 'text/javascript; charset=utf-8' },
  'ventas.js': { contenido: leer('ventas.js'), tipo: 'text/javascript; charset=utf-8' },
  'acceso.js': { contenido: leer('acceso.js'), tipo: 'text/javascript; charset=utf-8' },
  'plataforma.js': { contenido: leer('plataforma.js'), tipo: 'text/javascript; charset=utf-8' },
  'cobros.js': { contenido: leer('cobros.js'), tipo: 'text/javascript; charset=utf-8' },
  'compras.js': { contenido: leer('compras.js'), tipo: 'text/javascript; charset=utf-8' },
  'ajustes.js': { contenido: leer('ajustes.js'), tipo: 'text/javascript; charset=utf-8' },
  'estilo.css': { contenido: leer('estilo.css'), tipo: 'text/css; charset=utf-8' },
  'manifest.webmanifest': { contenido: leer('manifest.webmanifest'), tipo: 'application/manifest+json; charset=utf-8' },
  'icono-192.png': { contenido: leer('icono-192.png'), tipo: 'image/png' },
  'icono-512.png': { contenido: leer('icono-512.png'), tipo: 'image/png' },
};
// Versión del panel = huella de todos sus archivos: si se publica un cambio, la app instalada lo nota.
const VERSION_PANEL = Object.values(BASE).reduce((h, a) => h.update(a.contenido), createHash('sha256').update(PAGINA.contenido)).digest('hex').slice(0, 12);
const ARCHIVOS = {
  ...BASE,
  'sw.js': { contenido: Buffer.from(leer('sw.js').toString('utf8').replace("'__VERSION__'", `'${VERSION_PANEL}'`)), tipo: 'text/javascript; charset=utf-8' },
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src blob:; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type ErrorJson = (c: Context, estado: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429, codigo: string, mensaje: string) => Response;

export interface DependenciasPanel {
  db: Db;
  llaveMaestra: Buffer;
  almacen: Almacen;
  error: ErrorJson;
  ipCliente: (c: Context) => string;
  fallos: { contar(clave: string): boolean; excedido(clave: string): boolean };
  emitir: (c: Context, quien: { empresaId: string; canalId: string; usuarioId: string }, cuerpo: unknown) => Promise<Response>;
  respuestaComprobante: (c: Context, id: string) => Promise<unknown>;
  claveInstalacionValida: (clave: string) => boolean;
  claveRecuperacionValida: (clave: string) => boolean;
  recuperacionMuyCorta: boolean;
  instalacionMuyCorta: boolean;
  /** Correo (Resend) para los enlaces de recuperación. Sin esto, esa opción no aparece. */
  correo?: EnviarCorreo;
}

export function registrarPanel(app: Hono<any>, d: DependenciasPanel): void {
  const frenado = (c: Context) => d.error(c, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos fallidos; espera un minuto.');

  const servir = (c: Context, a: { contenido: Buffer; tipo: string }, extra: Record<string, string> = {}) => c.body(new Uint8Array(a.contenido), 200, {
    'Content-Type': a.tipo,
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-cache',
    // La cámara solo para esta página (escáner de códigos de barras).
    'Permissions-Policy': 'camera=(self)',
    ...extra,
  });
  for (const ruta of ['/panel', '/panel/']) app.get(ruta, (c) => servir(c, PAGINA));
  for (const [nombre, archivo] of Object.entries(ARCHIVOS)) {
    // El service worker vive en /panel/sw.js pero atiende también la página /panel (sin barra final).
    app.get(`/panel/${nombre}`, (c) => servir(c, archivo, nombre === 'sw.js' ? { 'Service-Worker-Allowed': '/panel' } : {}));
  }

  // Contra órdenes enviadas desde otro sitio (CSRF): cabecera propia + mismo origen.
  // Tope de datos por pedido: 100 KB; la foto de un recibo (ya achicada en el navegador), 512 KB.
  const limite = bodyLimit({ maxSize: 100 * 1024, onError: (c) => d.error(c, 413, 'DEMASIADO_GRANDE', 'Los datos superan los 100 KB.') });
  const limiteFoto = bodyLimit({ maxSize: 512 * 1024, onError: (c) => d.error(c, 413, 'DEMASIADO_GRANDE', 'La foto es muy pesada.') });
  app.use('/panel/api/*', (c, next) => (/^\/panel\/api\/gastos\/[^/]+\/foto$/.test(c.req.path) ? limiteFoto : limite)(c, next));
  app.use('/panel/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method !== 'GET') {
      const origen = c.req.header('origin');
      if (c.req.header('x-panel') !== '1' || (origen && origen !== origenPropio(c))) {
        return d.error(c, 403, 'ORIGEN_NO_PERMITIDO', 'Orden rechazada: no viene del panel.');
      }
    }
    return next();
  });

  const cookie = (c: Context) => getCookie(c, COOKIE);

  // ---------- Primera configuración (sin la PC) ----------
  // Crea el PRIMER usuario (dueño y administrador de la plataforma) desde el navegador.
  // Solo existe mientras la base no tenga NINGÚN usuario: en cuanto hay uno, estas rutas
  // dejan de servir para siempre.
  const hayUsuarios = async () => Boolean((await d.db.query(`SELECT 1 FROM usuarios LIMIT 1`)).rowCount);

  // La página es pública: hay que probar que eres el dueño. Sirve la CLAVE_INSTALACION de
  // Render o una llave de API vigente (fk_…) de ESA empresa, como la que la tienda tiene en
  // Vercel: solo quien controla la empresa la tiene, y así no hace falta entrar a Render.
  const pruebaDeDueno = async (clave: unknown, empresaId: string | undefined) => {
    const t = typeof clave === 'string' ? clave : '';
    if (d.claveInstalacionValida(t)) return true;
    return Boolean(empresaId) && (await autenticarLlave(d.db, t.trim()))?.empresaId === empresaId;
  };
  const claveIncorrecta = (c: Context, ip: string) => {
    if (!d.fallos.contar(ip)) return frenado(c);
    return d.instalacionMuyCorta
      ? d.error(c, 401, 'CLAVE_MUY_CORTA', 'La CLAVE_INSTALACION de Render es muy corta: debe tener 16 caracteres o más. O usa la llave de la tienda (fk_…).')
      : d.error(c, 401, 'CLAVE_INCORRECTA', 'Esa llave no es correcta para ese RUC. Copia la llave de la tienda (FACTURADOR_LLAVE en Vercel, empieza con fk_) completa.');
  };

  app.get('/panel/api/instalacion', async (c) => c.json({ disponible: !(await hayUsuarios()) }));

  app.post('/panel/api/instalacion', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ruc = typeof b.ruc === 'string' ? b.ruc.trim() : '';
    const empresa = (await d.db.query(`SELECT id FROM empresas WHERE ruc = $1`, [ruc])).rows[0];
    if (!(await pruebaDeDueno(b.clave, empresa?.id))) return claveIncorrecta(c, ip);
    if (!empresa) return d.error(c, 422, 'DATOS_INVALIDOS', `No existe la empresa con RUC ${ruc}.`);
    // Bloqueo: dos pestañas a la vez no pueden crear dos "primeros" usuarios.
    const email = (typeof b.email === 'string' ? b.email : '').trim().toLowerCase().slice(0, 200);
    try {
      const r = await enTransaccion(d.db, async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('panel-instalacion'))`);
        if ((await tx.query(`SELECT 1 FROM usuarios LIMIT 1`)).rowCount) return undefined;
        const u = await crearUsuario(tx, {
          email, nombre: typeof b.nombre === 'string' ? b.nombre.slice(0, 120) : '',
          contrasena: typeof b.contrasena === 'string' ? b.contrasena.slice(0, 200) : '', llaveMaestra: d.llaveMaestra,
        });
        await asignarEmpresa(tx, u.usuarioId, empresa.id as string, 'DUENO');
        await tx.query(`UPDATE usuarios SET admin_plataforma = true WHERE id = $1`, [u.usuarioId]);
        await tx.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'PANEL_INSTALACION', 'usuarios', $1, $2)`, [u.usuarioId, JSON.stringify({ ip })]);
        return u;
      });
      if (!r) return d.error(c, 409, 'YA_CONFIGURADO', 'El panel ya tiene usuarios: entra con el tuyo.');
      const url = urlOtpauth(email, r.secreto);
      // `url` abre la app autenticadora directo cuando se configura desde el mismo celular.
      return c.json({ usuarioId: r.usuarioId, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), clave: base32(r.secreto), url }, 201);
    } catch (e) {
      // Datos del usuario inválidos (correo, contraseña corta): se explica; lo demás es error interno.
      if (e instanceof Error && /contraseña|Correo/.test(e.message)) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Confirma el código de la app del primer usuario (vuelve a exigir la clave de instalación).
  app.post('/panel/api/instalacion/activar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof b.usuarioId === 'string' ? b.usuarioId : '';
    const unico = await d.db.query(`SELECT u.id, u.totp_activo, ue.empresa_id FROM usuarios u LEFT JOIN usuario_empresa ue ON ue.usuario_id = u.id`);
    const fila = unico.rows.length === 1 && unico.rows[0].id === id ? unico.rows[0] : undefined;
    if (!(await pruebaDeDueno(b.clave, fila?.empresa_id))) return claveIncorrecta(c, ip);
    if (!fila || fila.totp_activo) {
      return d.error(c, 409, 'YA_CONFIGURADO', 'El panel ya está configurado: entra con tu usuario.');
    }
    return activarConRespaldo(c, ip, id, b.codigo);
  });

  // ---------- Recuperar el acceso ----------
  // 1. Contraseña olvidada: enlace por correo (pide además el código de la app o uno de respaldo).
  // 2. Celular perdido: se entra con un código de respaldo en lugar del de la app.
  // 3. Perdió las dos cosas: contraseña y segundo paso nuevos, probando que es el DUEÑO con la
  //    llave de la tienda (fk_…) de su empresa, o con CLAVE_RECUPERACION puesta en Render.

  // Activa el segundo paso recién configurado y entrega los códigos de respaldo (se ven UNA vez).
  const activarConRespaldo = async (c: Context, ip: string, usuarioId: string, codigo: unknown) => {
    if (!(await activarTotp(d.db, usuarioId, typeof codigo === 'string' ? codigo.trim() : '', d.llaveMaestra))) {
      return d.fallos.contar(ip) ? d.error(c, 422, 'CODIGO_INCORRECTO', 'Ese código no coincide. Revisa que la hora del celular esté en automático.') : frenado(c);
    }
    return c.json({ ok: true, codigosRespaldo: await nuevosCodigosRespaldo(d.db, usuarioId) });
  };
  // Aviso al dueño de la cuenta: si no fue él, se entera enseguida.
  const avisarCambioDeAcceso = (email: string, como: string, ip: string) => {
    void d.correo?.({
      para: [email], asunto: 'Se cambió el acceso a tu facturador',
      texto: `Se cambió la contraseña de tu usuario del facturador (${como}, desde la dirección ${ip}).\n\nSi fuiste tú, no hagas nada. Si NO fuiste tú, avisa de inmediato a quien administra el facturador.`,
    }).catch((e: unknown) => console.error('[recuperar] no se pudo avisar:', e instanceof Error ? e.message : e));
  };

  const usuarioActivoPorCorreo = async (email: unknown) =>
    (await d.db.query(`SELECT id, email, totp_activo FROM usuarios WHERE lower(email) = lower($1) AND activo`, [typeof email === 'string' ? email.trim() : ''])).rows[0] as
      { id: string; email: string; totp_activo: boolean } | undefined;
  const pruebaParaRecuperar = async (clave: unknown, usuarioId: string | undefined) => {
    const t = typeof clave === 'string' ? clave : '';
    if (d.claveRecuperacionValida(t)) return true;
    if (!usuarioId) return false;
    const llave = await autenticarLlave(d.db, t.trim());
    if (!llave) return false;
    const dueno = await d.db.query(`SELECT 1 FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2 AND rol = 'DUENO'`, [usuarioId, llave.empresaId]);
    return Boolean(dueno.rowCount);
  };
  const recuperacionIncorrecta = (c: Context, ip: string) => {
    if (!d.fallos.contar(ip)) return frenado(c);
    return d.recuperacionMuyCorta
      ? d.error(c, 401, 'CLAVE_MUY_CORTA', 'La CLAVE_RECUPERACION de Render es muy corta: debe tener 16 caracteres o más. O usa la llave de la tienda (fk_…).')
      : d.error(c, 401, 'CLAVE_INCORRECTA', 'La llave no es correcta para ese correo. Usa la llave de la tienda (FACTURADOR_LLAVE en Vercel, empieza con fk_) de una empresa de la que eres dueño.');
  };

  app.get('/panel/api/recuperar', (c) => c.json({ correo: Boolean(d.correo) }));

  app.post('/panel/api/recuperar/correo', async (c) => {
    const ip = d.ipCliente(c);
    // Cada pedido cuenta (exista o no el correo): frena a quien quiera llenar buzones ajenos.
    if (d.fallos.excedido(ip) || !d.fallos.contar(ip)) return frenado(c);
    if (!d.correo) return d.error(c, 409, 'SIN_CORREO', 'El envío de correos no está configurado. Usa la llave de la tienda.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const enlace = await crearEnlaceRecuperacion(d.db, { email: typeof b.email === 'string' ? b.email.slice(0, 200) : '', ip });
    if (enlace) {
      // El token va después de "#": el navegador no lo manda a ningún servidor ni queda en registros.
      const url = `${origenPropio(c)}/panel#recuperar=${enlace.token}`;
      // Sin esperar el envío: la respuesta tarda lo mismo exista o no el correo.
      void d.correo({
        para: [enlace.email], asunto: 'Recupera tu acceso al facturador',
        texto: `Para poner una contraseña nueva abre este enlace (vale 30 minutos y una sola vez):\n\n${url}\n\nTe pedirá también el código de tu app autenticadora o uno de tus códigos de respaldo.\nSi no lo pediste tú, ignora este correo: tu contraseña no cambia.`,
      }).catch((e: unknown) => console.error('[recuperar] no se pudo enviar:', e instanceof Error ? e.message : e));
    }
    return c.json({ ok: true });
  });

  app.post('/panel/api/recuperar/correo/cambiar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await recuperarConEnlace(d.db, { token: crudo(b.token, 100), contrasena: crudo(b.contrasena, 200), codigo: crudo(b.codigo, 20).trim(), llaveMaestra: d.llaveMaestra });
    if (r.ok) {
      avisarCambioDeAcceso(r.email, 'con el enlace del correo', ip);
      return c.json({ ok: true, email: r.email });
    }
    if (r.motivo === 'CONTRASENA') return d.error(c, 422, 'DATOS_INVALIDOS', r.mensaje);
    if (!d.fallos.contar(ip)) return frenado(c);
    return r.motivo === 'ENLACE' ? d.error(c, 422, 'ENLACE_VENCIDO', r.mensaje) : d.error(c, 422, 'CODIGO_INCORRECTO', r.mensaje);
  });

  app.post('/panel/api/recuperar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const u = await usuarioActivoPorCorreo(b.email);
    if (!(await pruebaParaRecuperar(b.clave, u?.id))) return recuperacionIncorrecta(c, ip);
    if (!u) return d.error(c, 404, 'NO_ENCONTRADO', 'No hay un usuario activo con ese correo.');
    let secreto: Buffer;
    try {
      secreto = await restablecerAcceso(d.db, {
        usuarioId: u.id, contrasena: typeof b.contrasena === 'string' ? b.contrasena.slice(0, 200) : '', llaveMaestra: d.llaveMaestra, motivo: `web ${ip}`,
      });
    } catch (e) {
      if (e instanceof Error && /contraseña/.test(e.message)) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
    avisarCambioDeAcceso(u.email, 'con la llave de la tienda o la clave de Render', ip);
    const url = urlOtpauth(u.email, secreto);
    return c.json({ qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), clave: base32(secreto), url });
  });

  app.post('/panel/api/recuperar/activar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const u = await usuarioActivoPorCorreo(b.email);
    if (!(await pruebaParaRecuperar(b.clave, u?.id))) return recuperacionIncorrecta(c, ip);
    // Solo se activa un segundo paso recién restablecido (inactivo): no sirve para cambiar uno vigente.
    if (!u || u.totp_activo) return d.error(c, 409, 'NADA_QUE_ACTIVAR', 'No hay un acceso pendiente de activar para ese correo.');
    return activarConRespaldo(c, ip, u.id, b.codigo);
  });

  app.post('/panel/api/entrar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await entrar(d.db, {
      email: crudo(b.email, 200), contrasena: crudo(b.contrasena, 200), codigo: crudo(b.codigo, 20).trim(),
      llaveMaestra: d.llaveMaestra, ip, recordar: b.recordar === true,
    });
    if (!r.ok) {
      if (!d.fallos.contar(ip)) return frenado(c);
      return d.error(c, 401, 'DATOS_INCORRECTOS', r.bloqueado
        ? 'Cuenta bloqueada 15 minutos por demasiados intentos. Espera y vuelve a intentar.'
        : 'Correo, contraseña o código incorrectos.');
    }
    setCookie(c, COOKIE, r.token, { path: '/', httpOnly: true, secure: true, sameSite: 'Strict', expires: r.expira });
    return c.json({ ok: true });
  });

  // Desde aquí, todo exige sesión.
  const conSesion = async (c: Context): Promise<Sesion | Response> => {
    const s = await leerSesion(d.db, cookie(c));
    return s ?? d.error(c, 401, 'SIN_SESION', 'Tu sesión venció. Vuelve a entrar.');
  };
  const conEmpresa = async (c: Context) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    if (!s.empresa) return d.error(c, 403, 'SIN_EMPRESA', 'Tu usuario no tiene ninguna empresa asignada.');
    return { ...s, empresa: s.empresa };
  };

  app.post('/panel/api/salir', async (c) => {
    const token = cookie(c);
    if (token) await salir(d.db, token);
    deleteCookie(c, COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  });

  // Códigos de respaldo nuevos (los anteriores dejan de servir). Exige un código del momento.
  app.post('/panel/api/codigos-respaldo', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const codigos = await regenerarCodigosRespaldo(d.db, { usuarioId: s.usuarioId, codigo: typeof b.codigo === 'string' ? b.codigo.slice(0, 20).trim() : '', llaveMaestra: d.llaveMaestra });
    if (codigos) return c.json({ codigosRespaldo: codigos });
    return d.fallos.contar(ip) ? d.error(c, 422, 'CODIGO_INCORRECTO', 'El código no es correcto o ya se usó. Espera el siguiente.') : frenado(c);
  });

  app.post('/panel/api/sesiones/cerrar-otras', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    return c.json({ ok: true, cerradas: await cerrarOtrasSesiones(d.db, s) });
  });

  app.get('/panel/api/yo', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const canales = s.empresa
      ? (await d.db.query(`SELECT nombre FROM canales WHERE empresa_id = $1 AND tipo = 'MANUAL' AND activo ORDER BY nombre`, [s.empresa.id])).rows.map((x) => x.nombre as string)
      : [];
    // Tasa vigente del IGV (parámetro con fecha de vigencia): solo para SUGERIR montos en el formulario.
    const igv = (await d.db.query(
      `SELECT valor::text FROM parametros_tributarios WHERE codigo = 'IGV_TASA' AND regimen IS NULL
         AND vigente_desde <= current_date AND (vigente_hasta IS NULL OR vigente_hasta >= current_date) ORDER BY vigente_desde DESC LIMIT 1`,
    )).rows[0]?.valor as string | undefined;
    // Plan del cliente: el dueño y el administrador ven todo; los demás, solo si pueden emitir.
    const sus = s.empresa ? await suscripcionDe(d.db, s.empresa.id) : undefined;
    const plan = !sus ? null : ROLES_CORRIGEN.includes(s.empresa!.rol) ? sus : { puedeEmitir: sus.puedeEmitir, ...(sus.motivo ? { motivo: sus.motivo } : {}) };
    // Secciones que su plan no trae: el plan más barato que las incluye (para ofrecérselo).
    const bloqueadas = s.empresa?.bloqueadas.length
      ? (await d.db.query(
        `SELECT DISTINCT ON (sec) sec, p.nombre, p.precio_mensual::text AS precio
           FROM planes p, unnest(p.secciones) sec WHERE p.activo AND sec = ANY($1) ORDER BY sec, p.precio_mensual`,
        [s.empresa.bloqueadas],
      )).rows.map((x) => ({ seccion: x.sec, plan: x.nombre, precio: x.precio }))
      : [];
    return c.json({
      plan, bloqueadas,
      nombre: s.nombre, email: s.email, codigosRespaldo: await codigosRespaldoRestantes(d.db, s.usuarioId), empresas: s.empresas, empresa: s.empresa ?? null, canales, igvTasa: igv ?? null,
      puedeEmitir: Boolean(s.empresa && ROLES_EMISORES.includes(s.empresa.rol)),
      puedeCorregir: Boolean(s.empresa && ROLES_CORRIGEN.includes(s.empresa.rol) && s.empresa.modulos.includes('notas')),
      puedeAdministrar: Boolean(s.empresa && ROLES_CORRIGEN.includes(s.empresa.rol)),
      esDueno: s.empresa?.rol === 'DUENO',
      adminPlataforma: s.adminPlataforma,
      puedeComprar: Boolean(s.empresa && ROLES_COMPRAS.includes(s.empresa.rol) && s.empresa.modulos.includes('compras')),
      verEstadisticas: Boolean(s.empresa && ROLES_COMPRAS.includes(s.empresa.rol) && s.empresa.modulos.includes('estadisticas')),
      verCaja: Boolean(s.empresa && ROLES_COMPRAS.includes(s.empresa.rol) && s.empresa.modulos.includes('cobros')),
      verInventario: Boolean(s.empresa && ROLES_COMPRAS.includes(s.empresa.rol) && s.empresa.modulos.includes('productos')),
    });
  });

  app.post('/panel/api/empresa', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const b = (await c.req.json().catch(() => ({}))) as { empresaId?: unknown };
    if (typeof b.empresaId !== 'string' || !(await elegirEmpresa(d.db, s, b.empresaId))) {
      return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    }
    return c.json({ ok: true });
  });

  app.post('/panel/api/comprobantes', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_EMISORES.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no permite emitir comprobantes.');
    const b = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!b || typeof b.pedido !== 'string' || !PEDIDO_PANEL.test(b.pedido)) {
      return d.error(c, 422, 'DATOS_INVALIDOS', 'Falta el número interno del formulario. Recarga la página.');
    }
    // Solo canales manuales de la empresa elegida: el panel no emite como "Tienda web".
    const canal = await d.db.query(`SELECT id FROM canales WHERE empresa_id = $1 AND nombre = $2 AND tipo = 'MANUAL' AND activo`, [
      s.empresa.id, typeof b.canal === 'string' ? b.canal : '',
    ]);
    if (!canal.rows[0]) return d.error(c, 422, 'DATOS_INVALIDOS', 'Elige por dónde fue la venta (WhatsApp, Instagram o Presencial).');
    const { canal: _canal, ...cuerpo } = b;
    return d.emitir(c, { empresaId: s.empresa.id, canalId: canal.rows[0].id as string, usuarioId: s.usuarioId }, cuerpo);
  });

  app.get('/panel/api/comprobantes', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    const r = await d.db.query(
      `SELECT c.id, c.serie, c.numero, c.tipo_comprobante, c.fecha_emision::text AS fecha, c.estado::text AS estado,
              c.importe_total::text AS total, c.cliente_nombre, ca.nombre AS canal
         FROM comprobantes c JOIN canales ca ON ca.id = c.canal_id
        WHERE c.empresa_id = $1 ORDER BY c.creado_en DESC LIMIT 30`,
      [s.empresa.id],
    );
    return c.json({
      comprobantes: r.rows.map((x) => ({
        id: x.id, numero: idComprobanteLegible(x.serie, Number(x.numero)), tipo: x.tipo_comprobante, fecha: x.fecha,
        estado: x.estado, total: x.total, cliente: x.cliente_nombre, canal: x.canal,
      })),
    });
  });

  /** El comprobante debe ser de la empresa elegida; si no, 404 (igual que si no existiera). */
  const deLaEmpresa = async (empresaId: string, id: string) =>
    UUID.test(id) && (await d.db.query(`SELECT 1 FROM comprobantes WHERE id = $1 AND empresa_id = $2`, [id, empresaId])).rowCount ? id : undefined;

  app.get('/panel/api/comprobantes/:id', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    const id = await deLaEmpresa(s.empresa.id, c.req.param('id'));
    if (!id) return d.error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    return c.json(await d.respuestaComprobante(c, id));
  });

  app.get('/panel/api/comprobantes/:id/pdf', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    const id = await deLaEmpresa(s.empresa.id, c.req.param('id'));
    if (!id) return d.error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const formato = c.req.query('formato');
    if (formato !== undefined && !esFormatoPdf(formato)) return d.error(c, 400, 'FORMATO_INVALIDO', 'formato debe ser A4 o TICKET_80.');
    try {
      const r = await pdfDeComprobante(d.db, id, { almacen: d.almacen, ...(formato ? { formato } : {}) });
      return c.body(new Uint8Array(r.pdf), 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.nombreArchivo}"` });
    } catch (e) {
      if (e instanceof ErrorPdf) return d.error(c, 409, 'PDF_NO_DISPONIBLE', e.message);
      throw e;
    }
  });

  const sinModulo = (c: Context, m: Modulo) => d.error(c, 403, 'MODULO_DESACTIVADO', `La función "${m}" está desactivada para esta empresa.`);
  const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  // Invitar a una persona: si es nueva, recibe un ENLACE y ella misma pone su contraseña y su app.
  const enlaceInvitacion = (c: Context, token: string) => `${origenPropio(c)}/panel#invitacion=${token}`;
  const avisarInvitacion = (para: string, enlace: string, empresa: string) => {
    void d.correo?.({
      para: [para], asunto: `Te invitaron al facturador de ${empresa}`,
      texto: `Para entrar, abre este enlace (vale 72 horas) y crea tu contraseña:\n\n${enlace}\n\nTen a mano Google Authenticator en tu celular.`,
    }).catch((e: unknown) => console.error('[invitacion] no se pudo enviar:', e instanceof Error ? e.message : e));
  };
  const comun = { d, conSesion, conEmpresa, deLaEmpresa, sinModulo, texto, frenado, enlaceInvitacion, avisarInvitacion };

  app.get('/panel/api/tablero', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    return c.json(await tablero(d.db, s.empresa.id, { modulos: s.empresa.modulos, porPagar: ROLES_COMPRAS.includes(s.empresa.rol) }));
  });

  // Cuánto se vende y de dónde: solo quienes responden por la empresa y el contador.
  app.get('/panel/api/estadisticas', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('estadisticas')) return sinModulo(c, 'estadisticas');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no puede ver las estadísticas de ventas.');
    const m = s.empresa.modulos;
    return c.json({
      ...(await estadisticas(d.db, s.empresa.id, { compras: m.includes('compras'), productos: m.includes('productos') })),
      resultado: await resultadoDelMes(d.db, s.empresa.id, ahoraLima().fecha.slice(0, 7), { compras: m.includes('compras'), gastos: m.includes('cobros') }),
    });
  });

  // Productos guardados, para elegirlos al emitir en vez de escribirlos.
  app.get('/panel/api/productos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('productos')) return sinModulo(c, 'productos');
    const r = await d.db.query(
      `SELECT sku, nombre, precio_con_igv::numeric(14,2)::text AS precio, codigo_barras FROM productos WHERE empresa_id = $1 AND activo ORDER BY nombre LIMIT 2000`,
      [s.empresa.id],
    );
    return c.json({ productos: r.rows.map((p) => ({ sku: p.sku, nombre: p.nombre, precio: p.precio, codigoBarras: p.codigo_barras })) });
  });

  registrarVentas(app, comun);

  app.post('/panel/api/contrasena', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await cambiarContrasena(d.db, {
      usuarioId: s.usuarioId, sesionId: s.sesionId, actual: texto(b.actual, 200), nueva: typeof b.nueva === 'string' ? b.nueva.slice(0, 200) : '',
      codigo: texto(b.codigo, 6), llaveMaestra: d.llaveMaestra,
    });
    if (!r.ok) return d.fallos.contar(ip) ? d.error(c, 422, 'NO_SE_PUDO', r.mensaje) : frenado(c);
    return c.json({ ok: true });
  });

  registrarInventario(app, comun);
  registrarCobros(app, comun);
  // Logo para el PDF (el navegador lo achica antes de enviarlo).
  app.post('/panel/api/logo', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador cambia el logo.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const base64 = typeof b.imagen === 'string' ? b.imagen.replace(/^data:image\/(png|jpeg);base64,/, '') : '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Imagen inválida.');
    try {
      await guardarLogo(d.db, d.almacen, { empresaId: s.empresa.id, imagen: Buffer.from(base64, 'base64'), usuarioId: s.usuarioId });
    } catch (e) {
      if (e instanceof ErrorLogo) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
    return c.json({ ok: true });
  });

  registrarPlataforma(app, comun);

  // ---------- Empresas, certificado y usuarios ----------

  // Alta de una empresa NUEVA (solo administrador de la plataforma). Quien la crea queda como DUEÑO.
  app.post('/panel/api/empresas', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    if (!s.adminPlataforma) return d.error(c, 403, 'SIN_PERMISO', 'Solo el administrador de la plataforma da de alta empresas.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ruc = texto(b.ruc, 11);
    if ((await d.db.query(`SELECT 1 FROM empresas WHERE ruc = $1`, [ruc])).rowCount) {
      return d.error(c, 409, 'YA_EXISTE', 'Esa empresa ya existe: pide al dueño que te dé acceso.');
    }
    const regimen = texto(b.regimen, 20) as Regimen;
    if (!['NUEVO_RUS', 'RER', 'MYPE_TRIBUTARIO', 'GENERAL'].includes(regimen)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Elige el régimen tributario.');
    try {
      const { empresaId } = await configurarEmpresa(d.db, {
        ruc, razonSocial: texto(b.razonSocial, 200), ubigeo: texto(b.ubigeo, 6), departamento: texto(b.departamento, 60),
        provincia: texto(b.provincia, 60), distrito: texto(b.distrito, 60), direccion: texto(b.direccion, 250), regimen,
        regimenDesde: texto(b.regimenDesde, 10), ...(texto(b.marca, 100) ? { marca: texto(b.marca, 100) } : {}),
      });
      await asignarEmpresa(d.db, s.usuarioId, empresaId, 'DUENO');
      // Empresa de un cliente: empieza con días de prueba. Una propia (otro RUC tuyo) no tiene plan.
      if (b.propia !== true) {
        await iniciarPrueba(d.db, { empresaId, ...(texto(b.plan, 20) ? { plan: texto(b.plan, 20) } : {}), ...(texto(b.contacto, 200) ? { contacto: texto(b.contacto, 200) } : {}) });
      }
      // Queda elegida en esta sesión para seguir configurándola (certificado, usuarios).
      await d.db.query(`UPDATE sesiones SET empresa_id = $2 WHERE id = $1`, [s.sesionId, empresaId]);
      return c.json({ ok: true, empresaId }, 201);
    } catch (e) {
      if (e instanceof ErrorEmpresa) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Certificado digital (.pfx/.p12) de la empresa elegida: solo el DUEÑO. Se guarda cifrado.
  app.post('/panel/api/certificado', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño de la empresa carga el certificado digital.');
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const base64 = typeof b.pfx === 'string' ? b.pfx.replace(/^data:[^;]*;base64,/, '') : '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 60_000) return d.error(c, 422, 'DATOS_INVALIDOS', 'Elige el archivo .pfx o .p12 del certificado.');
    try {
      const r = await guardarCertificado(d.db, {
        empresaId: s.empresa.id, pfx: Buffer.from(base64, 'base64'), clave: typeof b.clave === 'string' ? b.clave.slice(0, 200) : '', llaveMaestra: d.llaveMaestra,
      });
      await d.db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id) VALUES ($1, $2, 'CARGAR_CERTIFICADO', 'empresas', $1)`, [s.empresa.id, s.usuarioId]);
      return c.json({ ok: true, titular: r.certificado.sujeto, vence: r.certificado.validoHasta.toISOString().slice(0, 10) });
    } catch (e) {
      // Una contraseña equivocada cuenta como intento fallido (no se puede adivinar sin fin).
      if (e instanceof ErrorCertificado) return d.fallos.contar(ip) ? d.error(c, 422, 'CERTIFICADO_INVALIDO', e.message) : frenado(c);
      throw e;
    }
  });

  app.get('/panel/api/usuarios', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño administra los usuarios.');
    const r = await d.db.query(
      `SELECT u.id, u.email, u.nombre, ue.rol::text AS rol, u.activo, u.totp_activo FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id
        WHERE ue.empresa_id = $1 ORDER BY u.nombre`,
      [s.empresa.id],
    );
    return c.json({ usuarios: r.rows.map((x) => ({ id: x.id, email: x.email, nombre: x.nombre, rol: x.rol, activo: x.activo, dosPasos: x.totp_activo, pendiente: !x.totp_activo })) });
  });

  // Dar acceso a otra persona (vendedor, contador…). Si el correo es nuevo, se crea el usuario
  // y se devuelve el QR para que lo escanee en SU celular; queda activo al confirmar el código.

  app.post('/panel/api/usuarios', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño da acceso a otras personas.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rol = texto(b.rol, 20).toUpperCase() as Rol;
    if (!ROLES.includes(rol) || rol === 'DUENO') return d.error(c, 422, 'DATOS_INVALIDOS', 'Rol: ADMIN, VENDEDOR, CONTADOR o SOLO_LECTURA.');
    const plan = await suscripcionDe(d.db, s.empresa.id);
    if (plan?.limiteUsuarios != null && plan.usuarios >= plan.limiteUsuarios) {
      return d.error(c, 403, 'LIMITE_PLAN', `Tu plan ${plan.nombrePlan} permite ${plan.limiteUsuarios} usuario(s). Cambia a un plan mayor para agregar más.`);
    }
    try {
      const r = await invitar(d.db, { email: texto(b.email, 200), nombre: texto(b.nombre, 120), empresaId: s.empresa.id, rol, creadaPor: s.usuarioId });
      if (r.existente) return c.json({ ok: true, existente: true });
      const enlace = enlaceInvitacion(c, r.token);
      avisarInvitacion(texto(b.email, 200).toLowerCase(), enlace, s.empresa.razonSocial);
      return c.json({ ok: true, existente: false, usuarioId: r.usuarioId, enlace, expira: r.expira, porCorreo: Boolean(d.correo) }, 201);
    } catch (e) {
      if (e instanceof ErrorInvitacion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Enlace nuevo para quien aún no activó su acceso (se le venció o lo perdió).
  app.post('/panel/api/usuarios/:id/enlace', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño invita.');
    const id = c.req.param('id');
    const deEsta = UUID.test(id) && (await d.db.query(`SELECT 1 FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2`, [id, s.empresa.id])).rowCount;
    if (!deEsta) return d.error(c, 404, 'NO_ENCONTRADO', 'Usuario no encontrado.');
    try {
      const r = await nuevoEnlace(d.db, { usuarioId: id, empresaId: s.empresa.id, creadaPor: s.usuarioId });
      return c.json({ ok: true, enlace: enlaceInvitacion(c, r.token), expira: r.expira });
    } catch (e) {
      if (e instanceof ErrorInvitacion) return d.error(c, 409, 'YA_ACTIVO', e.message);
      throw e;
    }
  });

  // ---------- Abrir la invitación (sin sesión; el token es la prueba) ----------
  app.get('/panel/api/invitacion', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const v = await verInvitacion(d.db, (c.req.query('token') ?? '').slice(0, 100));
    if (v) return c.json(v);
    return d.fallos.contar(ip) ? d.error(c, 404, 'ENLACE_VENCIDO', 'El enlace venció o ya se usó. Pide uno nuevo a quien te invitó.') : frenado(c);
  });

  app.post('/panel/api/invitacion', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const r = await aceptarInvitacion(d.db, { token: texto(b.token, 100), contrasena: typeof b.contrasena === 'string' ? b.contrasena.slice(0, 200) : '', llaveMaestra: d.llaveMaestra });
      if (!r) return d.fallos.contar(ip) ? d.error(c, 404, 'ENLACE_VENCIDO', 'El enlace venció o ya se usó. Pide uno nuevo a quien te invitó.') : frenado(c);
      const url = urlOtpauth(r.email, r.secreto);
      return c.json({ qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }), clave: base32(r.secreto), url });
    } catch (e) {
      if (e instanceof Error && /contraseña/.test(e.message)) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  app.post('/panel/api/invitacion/activar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await activarInvitacion(d.db, { token: texto(b.token, 100), codigo: texto(b.codigo, 6).trim(), llaveMaestra: d.llaveMaestra });
    if (r === 'ENLACE') return d.fallos.contar(ip) ? d.error(c, 404, 'ENLACE_VENCIDO', 'El enlace venció o ya se usó. Pide uno nuevo a quien te invitó.') : frenado(c);
    if (r === 'CODIGO') return d.fallos.contar(ip) ? d.error(c, 422, 'CODIGO_INCORRECTO', 'Ese código no coincide. Revisa que la hora del celular esté en automático.') : frenado(c);
    return c.json({ ok: true, email: r.email, codigosRespaldo: r.codigos });
  });

  // ---------- Lista de configuración de la empresa (para empezar a emitir) ----------
  app.get('/panel/api/configuracion', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador.');
    const e = (await d.db.query(
      `SELECT e.ambiente_sunat::text AS ambiente,
              (SELECT valido_hasta::date >= current_date FROM certificados WHERE empresa_id = e.id AND activo) AS certificado,
              EXISTS (SELECT 1 FROM credenciales_sol WHERE empresa_id = e.id AND ambiente = 'PRODUCCION') AS sol,
              EXISTS (SELECT 1 FROM archivos WHERE empresa_id = e.id AND tipo = 'LOGO') AS logo,
              EXISTS (SELECT 1 FROM comprobantes WHERE empresa_id = e.id AND estado IN ('ACEPTADO', 'ACEPTADO_OBS')) AS aceptado,
              (SELECT count(*) FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id WHERE ue.empresa_id = e.id AND u.totp_activo)::int AS usuarios
         FROM empresas e WHERE e.id = $1`,
      [s.empresa.id],
    )).rows[0];
    const pasos = [
      { clave: 'datos', titulo: 'Datos de la empresa (Ficha RUC)', listo: true, ayuda: 'Ya están registrados.' },
      { clave: 'certificado', titulo: 'Certificado digital', listo: e.certificado === true,
        ayuda: e.certificado === false ? 'Tu certificado VENCIÓ: carga uno nuevo en Más → Certificado.' : 'Cárgalo en Más → Certificado digital (.pfx o .p12 y su contraseña).' },
      { clave: 'prueba', titulo: 'Primera boleta de prueba aceptada por SUNAT (beta)', listo: e.aceptado,
        ayuda: 'Emite una boleta de prueba en Vender. En beta no tiene valor legal.' },
      { clave: 'logo', titulo: 'Logo para tus comprobantes (opcional)', listo: e.logo, ayuda: 'Súbelo en Más → Logo.' },
      { clave: 'sol', titulo: 'Usuario SOL secundario (para producción)', listo: e.sol,
        ayuda: 'Créalo en SUNAT Operaciones en Línea con permisos solo para comprobantes electrónicos; nunca uses tu Clave SOL principal. Luego guárdalo en Más.' },
      { clave: 'produccion', titulo: 'Emitir comprobantes reales (producción)', listo: e.ambiente === 'PRODUCCION',
        ayuda: 'Cuando todo lo anterior esté listo, pide a tu proveedor del facturador que active producción.' },
    ];
    return c.json({ pasos, usuarios: e.usuarios });
  });

  // Usuario SOL SECUNDARIO de la empresa (solo para producción). Se guarda cifrado.
  app.post('/panel/api/sol', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño guarda el usuario SOL.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const clave = typeof b.clave === 'string' ? b.clave : '';
    if (clave.length < 8 || clave.length > 12) return d.error(c, 422, 'DATOS_INVALIDOS', 'La clave SOL tiene entre 8 y 12 caracteres.');
    try {
      await guardarCredencialesSol(d.db, s.empresa.id, texto(b.usuario, 20), clave, d.llaveMaestra);
    } catch (e) {
      if (e instanceof ErrorConfiguracionSunat) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
    await d.db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id) VALUES ($1, $2, 'GUARDAR_USUARIO_SOL', 'empresas', $1)`, [s.empresa.id, s.usuarioId]);
    return c.json({ ok: true });
  });
}
