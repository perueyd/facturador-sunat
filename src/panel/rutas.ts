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
import { solicitarAnulacion } from '../comprobantes/anular.js';
import { esFormatoPdf, pdfDeComprobante } from '../comprobantes/pdf-comprobante.js';
import { enTransaccion, type Db } from '../db/conexion.js';
import { CATEGORIAS_GASTO, ErrorGasto, anularGasto, gastosDelPeriodo, registrarGasto } from '../cobros/gastos.js';
import { ErrorCuenta, caja, cerrarCaja, cierresDeCaja, guardarCuenta, lineasParaCerrar, listarCuentas } from '../cobros/caja.js';
import { MEDIOS_PAGO, registrarPago, sqlSaldo, type MedioPago } from '../cobros/pagos.js';
import { ErrorDevolucion, registrarDevolucion } from '../devoluciones/devoluciones.js';
import { ErrorEmpresa, configurarEmpresa } from '../empresas/configurar.js';
import { ErrorLogo, guardarLogo } from '../empresas/logo.js';
import { ErrorCertificado } from '../firma/certificado.js';
import { guardarCertificado } from '../firma/repositorio-certificados.js';
import { base32, urlOtpauth } from '../seguridad/totp.js';
import { registrarCompra } from '../inventario/compras.js';
import { ErrorInventario, ajustarStock, guardarProducto, listarStock } from '../inventario/productos.js';
import { asignarProveedor, guardarDiasEntrega, kardex, reposicion } from '../inventario/reposicion.js';
import { ErrorPdf } from '../pdf/representacion.js';
import { ErrorSuscripcion, actividadPlataforma, cambiarSuscripcion, clientes, iniciarPrueba, registrarPago as registrarPagoPlan, suscripcionDe } from '../plataforma/suscripciones.js';
import { saludPlataforma } from '../plataforma/vigilancia.js';
import { ahoraLima, esFecha, sumarDias } from '../fechas.js';
import { clientesFrecuentes, guardarCelular, normalizarCelular } from '../reportes/cliente.js';
import { estadisticas } from '../reportes/estadisticas.js';
import { masVendidos } from '../reportes/venta-rapida.js';
import { ErrorCotizacion, anularCotizacion, cargarCotizacion, crearCotizacion, listarCotizaciones, marcarConvertida, pdfCotizacion, type Cotizacion } from '../cotizaciones/cotizaciones.js';
import { tokenCotizacion } from '../api/enlaces.js';
import { SECCIONES_DE_PLAN, tablero, type Modulo } from '../reportes/tablero.js';
import { idComprobanteLegible } from '../tipos.js';
import QRCode from 'qrcode';
import type { Regimen } from '../tipos.js';
import {
  ROLES, ROLES_EMISORES, activarTotp, asignarEmpresa, cambiarContrasena, cerrarOtrasSesiones, codigosRespaldoRestantes, crearEnlaceRecuperacion,
  crearUsuario, elegirEmpresa, entrar, leerSesion, nuevosCodigosRespaldo, recuperarConEnlace, regenerarCodigosRespaldo, restablecerAcceso, salir,
  type Rol, type Sesion,
} from './usuarios.js';

/** Notas de crédito, anulaciones, productos y stock: solo quienes responden por la empresa. */
const ROLES_CORRIGEN: readonly Rol[] = ['DUENO', 'ADMIN'];
/** Compras de proveedores: también el contador. */
const ROLES_COMPRAS: readonly Rol[] = ['DUENO', 'ADMIN', 'CONTADOR'];

const COOKIE = '__Host-panel';
/** Texto tal como llegó (sin recortar espacios: una contraseña puede tenerlos), con tope de largo. */
const crudo = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El panel genera el número de pedido al abrir el formulario: pulsar dos veces no emite dos. */
const PEDIDO_PANEL = /^PANEL-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const leer = (archivo: string) => readFileSync(new URL(`./publico/${archivo}`, import.meta.url));
const PAGINA = { contenido: leer('index.html'), tipo: 'text/html; charset=utf-8' };
const BASE = {
  'app.js': { contenido: leer('app.js'), tipo: 'text/javascript; charset=utf-8' },
  'estilo.css': { contenido: leer('estilo.css'), tipo: 'text/css; charset=utf-8' },
  'manifest.webmanifest': { contenido: leer('manifest.webmanifest'), tipo: 'application/manifest+json; charset=utf-8' },
  'icono-192.png': { contenido: leer('icono-192.png'), tipo: 'image/png' },
  'icono-512.png': { contenido: leer('icono-512.png'), tipo: 'image/png' },
};
// Versión del panel = huella de sus archivos: si se publica un cambio, la app instalada lo nota.
const VERSION_PANEL = createHash('sha256').update(PAGINA.contenido).update(BASE['app.js'].contenido).update(BASE['estilo.css'].contenido).digest('hex').slice(0, 12);
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

/**
 * CSV que Excel en español abre bien (BOM + punto y coma). Una celda que empieza con = + - @
 * sería una fórmula: se neutraliza.
 */
function csvParaExcel(lineas: unknown[][]): string {
  const celda = (v: unknown) => {
    const t = String(v ?? '');
    const seguro = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return /[;"\n]/.test(seguro) ? `"${seguro.replaceAll('"', '""')}"` : seguro;
  };
  return '\uFEFF' + lineas.map((l) => l.map(celda).join(';')).join('\r\n') + '\r\n';
}

/** Origen público de esta petición (detrás de Render llega por https aunque el servidor vea http). */
function origenPropio(c: Context): string {
  const url = new URL(c.req.url);
  return `${c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1)}://${url.host}`;
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
  app.use('/panel/api/*', bodyLimit({ maxSize: 100 * 1024, onError: (c) => d.error(c, 413, 'DEMASIADO_GRANDE', 'Los datos superan los 100 KB.') }));
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

  app.get('/panel/api/tablero', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    return c.json(await tablero(d.db, s.empresa.id, { modulos: s.empresa.modulos }));
  });

  // Cuánto se vende y de dónde: solo quienes responden por la empresa y el contador.
  app.get('/panel/api/estadisticas', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('estadisticas')) return sinModulo(c, 'estadisticas');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no puede ver las estadísticas de ventas.');
    return c.json(await estadisticas(d.db, s.empresa.id, {
      compras: s.empresa.modulos.includes('compras'), productos: s.empresa.modulos.includes('productos'),
    }));
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

  // ---------- Cotizaciones (proformas): no son comprobantes; al pagar se emite la boleta o factura ----------
  const sesionCotizar = async (c: Context) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_EMISORES.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no permite hacer cotizaciones.');
    return s;
  };
  const conEnlace = (c: Context, k: Cotizacion) => ({ ...k, enlace: `${origenPropio(c)}/q/${tokenCotizacion(d.llaveMaestra, k.id)}` });
  app.get('/panel/api/cotizaciones', async (c) => {
    const s = await sesionCotizar(c);
    if (s instanceof Response) return s;
    return c.json({ cotizaciones: (await listarCotizaciones(d.db, s.empresa.id)).map((k) => conEnlace(c, k)) });
  });
  app.post('/panel/api/cotizaciones', async (c) => {
    const s = await sesionCotizar(c);
    if (s instanceof Response) return s;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cli = (b.cliente && typeof b.cliente === 'object' ? b.cliente : {}) as Record<string, unknown>;
    const items = Array.isArray(b.items) ? b.items.slice(0, 101) : [];
    try {
      const k = await crearCotizacion(d.db, s.empresa.id, {
        cliente: { tipoDocumento: texto(cli.tipoDocumento, 10) || 'NINGUNO', numero: texto(cli.numero, 15), nombre: texto(cli.nombre, 200) },
        items: items.map((x) => {
          const i = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
          return { codigo: texto(i.codigo, 40), descripcion: texto(i.descripcion, 250), cantidad: texto(String(i.cantidad ?? ''), 30).replace(',', '.'), precio: texto(String(i.precio ?? ''), 30).replace(',', '.') };
        }),
        diasValidez: typeof b.diasValidez === 'number' ? b.diasValidez : 7,
        ...(typeof b.nota === 'string' ? { nota: b.nota } : {}),
      }, s.usuarioId, ahoraLima().fecha);
      return c.json(conEnlace(c, k), 201);
    } catch (e) {
      if (e instanceof ErrorCotizacion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });
  app.get('/panel/api/cotizaciones/:id/pdf', async (c) => {
    const s = await sesionCotizar(c);
    if (s instanceof Response) return s;
    const id = c.req.param('id');
    const k = UUID.test(id) ? await cargarCotizacion(d.db, s.empresa.id, id) : undefined;
    if (!k) return d.error(c, 404, 'NO_ENCONTRADO', 'Cotización no encontrada.');
    return c.body(new Uint8Array(await pdfCotizacion(d.db, s.empresa.id, k, d.almacen)), 200, {
      'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${k.numero}.pdf"`, 'Cache-Control': 'private, no-store',
    });
  });
  app.post('/panel/api/cotizaciones/:id/anular', async (c) => {
    const s = await sesionCotizar(c);
    if (s instanceof Response) return s;
    const id = c.req.param('id');
    return UUID.test(id) && (await anularCotizacion(d.db, s.empresa.id, id, s.usuarioId))
      ? c.json({ ok: true }) : d.error(c, 409, 'NO_SE_PUEDE', 'Solo se anula una cotización vigente.');
  });
  app.post('/panel/api/cotizaciones/:id/convertida', async (c) => {
    const s = await sesionCotizar(c);
    if (s instanceof Response) return s;
    const id = c.req.param('id');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const comprobante = typeof b.comprobanteId === 'string' ? b.comprobanteId : '';
    return UUID.test(id) && UUID.test(comprobante) && (await marcarConvertida(d.db, s.empresa.id, id, comprobante, s.usuarioId))
      ? c.json({ ok: true }) : d.error(c, 409, 'NO_SE_PUEDE', 'La cotización ya no está vigente o el comprobante no es de esta empresa.');
  });

  app.get('/panel/api/venta-rapida', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    return c.json({ productos: await masVendidos(d.db, s.empresa.id, ahoraLima().fecha) });
  });

  // Cliente ya conocido: con el DNI o RUC se completa el nombre.
  app.get('/panel/api/clientes', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    const doc = c.req.query('doc') ?? '';
    if (!/^[0-9A-Za-z]{4,15}$/.test(doc)) return d.error(c, 400, 'DOCUMENTO_INVALIDO', 'Documento inválido.');
    const r = await d.db.query(`SELECT nombre_razon_social AS nombre FROM clientes WHERE empresa_id = $1 AND numero_doc = $2 LIMIT 1`, [s.empresa.id, doc]);
    return r.rows[0] ? c.json({ nombre: r.rows[0].nombre }) : d.error(c, 404, 'NO_ENCONTRADO', 'Cliente nuevo.');
  });

  // Clientes frecuentes y su celular (para mandarles un WhatsApp con el mensaje listo).
  app.get('/panel/api/clientes/frecuentes', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    return c.json({ clientes: await clientesFrecuentes(d.db, s.empresa.id, ahoraLima().fecha) });
  });
  app.post('/panel/api/clientes/celular', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_EMISORES.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no cambia datos de clientes.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const texto = typeof b.celular === 'string' ? b.celular.trim() : '';
    const celular = texto ? normalizarCelular(texto) : null;
    if (celular === undefined) return d.error(c, 422, 'DATOS_INVALIDOS', 'Celular inválido: 9 dígitos que empiezan con 9 (ej. 987 654 321), o con + y el código si es de otro país.');
    const ok = await guardarCelular(d.db, s.empresa.id, { tipoDocumento: typeof b.tipoDocumento === 'string' ? b.tipoDocumento.slice(0, 2) : '', numero: typeof b.numero === 'string' ? b.numero.slice(0, 20) : '' }, celular, s.usuarioId);
    return ok ? c.json({ ok: true, celular }) : d.error(c, 404, 'NO_ENCONTRADO', 'Cliente no encontrado.');
  });

  // Ventas de un mes en CSV (Excel lo abre directo), para el contador.
  app.get('/panel/api/exportar', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('exportar')) return sinModulo(c, 'exportar');
    const mes = c.req.query('mes') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return d.error(c, 400, 'MES_INVALIDO', 'Indica el mes como AAAA-MM.');
    const r = await d.db.query(
      `SELECT co.fecha_emision::text AS fecha, co.tipo_comprobante, co.serie, co.numero, co.cliente_numero_doc, co.cliente_nombre,
              (co.total_gravado + co.total_exonerado + co.total_inafecto)::text AS base, co.total_igv::text AS igv, co.importe_total::text AS total,
              co.estado::text AS estado, co.estado_pago::text AS pago, ca.nombre AS canal
         FROM comprobantes co JOIN canales ca ON ca.id = co.canal_id
        WHERE co.empresa_id = $1 AND to_char(co.fecha_emision, 'YYYY-MM') = $2 ORDER BY co.fecha_emision, co.serie, co.numero`,
      [s.empresa.id, mes],
    );
    const TIPOS: Record<string, string> = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito' };
    const lineas = [
      ['Fecha', 'Tipo', 'Número', 'Doc. cliente', 'Cliente', 'Base imponible', 'IGV', 'Total', 'Estado SUNAT', 'Pago', 'Canal'],
      ...r.rows.map((x) => [
        x.fecha, TIPOS[x.tipo_comprobante] ?? x.tipo_comprobante, idComprobanteLegible(x.serie, Number(x.numero)), x.cliente_numero_doc,
        x.cliente_nombre, x.base, x.igv, x.total, x.estado, x.pago, x.canal,
      ]),
    ];
    return c.body(csvParaExcel(lineas), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ventas-${s.empresa.ruc}-${mes}.csv"`,
    });
  });

  // Devolución total: nota de crédito por todo lo que quede por devolver; el stock vuelve.
  app.post('/panel/api/comprobantes/:id/devolucion', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('notas')) return sinModulo(c, 'notas');
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador emite notas de crédito.');
    const id = await deLaEmpresa(s.empresa.id, c.req.param('id'));
    if (!id) return d.error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const lineas = await d.db.query(
      `SELECT i.orden, (i.cantidad - coalesce((SELECT sum(di.cantidad) FROM devolucion_items di JOIN devoluciones dv ON dv.id = di.devolucion_id
                JOIN comprobantes nc ON nc.id = dv.nota_credito_id WHERE dv.comprobante_origen_id = i.comprobante_id AND di.item_orden = i.orden
                AND nc.estado NOT IN ('RECHAZADO', 'ANULADO')), 0))::text AS queda
         FROM comprobante_items i WHERE i.comprobante_id = $1 ORDER BY i.orden`,
      [id],
    );
    const items = lineas.rows.filter((x) => Number.parseFloat(x.queda) > 0).map((x) => ({ orden: Number(x.orden), cantidad: x.queda as string }));
    if (!items.length) return d.error(c, 409, 'YA_DEVUELTO', 'Este comprobante ya fue devuelto por completo.');
    try {
      const r = await registrarDevolucion(d.db, { empresaId: s.empresa.id, comprobanteId: id, motivo: texto(b.motivo, 200), items, usuarioId: s.usuarioId });
      return c.json(await d.respuestaComprobante(c, r.notaCreditoId), 201);
    } catch (e) {
      if (e instanceof ErrorDevolucion) return d.error(c, 422, 'NO_SE_PUEDE_DEVOLVER', e.message);
      throw e;
    }
  });

  // Anular (error al emitir): comunicación de baja o resumen diario, dentro del plazo.
  app.post('/panel/api/comprobantes/:id/anular', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('notas')) return sinModulo(c, 'notas');
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador anula comprobantes.');
    const id = await deLaEmpresa(s.empresa.id, c.req.param('id'));
    if (!id) return d.error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await solicitarAnulacion(d.db, { comprobanteId: id, motivo: texto(b.motivo, 200), usuarioId: s.usuarioId });
    if (r.resultado === 'ERROR') return d.error(c, 422, 'NO_SE_PUEDE_ANULAR', r.errores.join(' '));
    return c.json({ ok: true, via: r.via, documento: r.identificador });
  });

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

  // ---------- Compras, stock y cobros ----------

  /** Errores de negocio (datos que no cuadran) se explican; lo demás es error interno. */
  const negocio = (c: Context, e: unknown) => {
    if (e instanceof ErrorInventario) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
    throw e;
  };

  app.get('/panel/api/stock', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('productos')) return sinModulo(c, 'productos');
    return c.json({ stock: await listarStock(d.db, s.empresa.id) });
  });

  app.post('/panel/api/productos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('productos')) return sinModulo(c, 'productos');
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador crea productos.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      await guardarProducto(d.db, s.empresa.id, {
        sku: texto(b.sku, 40), nombre: texto(b.nombre, 250), precio: texto(b.precio, 20) || '0',
        controlaStock: b.controlaStock !== false, ...(texto(b.stockMinimo, 20) ? { stockMinimo: texto(b.stockMinimo, 20) } : {}),
        ...(typeof b.codigoBarras === 'string' && b.codigoBarras.trim() ? { codigoBarras: texto(b.codigoBarras, 40) } : {}),
      });
    } catch (e) {
      return negocio(c, e);
    }
    return c.json({ ok: true }, 201);
  });

  // Ajuste de stock (conteo físico, merma): motivo obligatorio; queda en el historial.
  app.post('/panel/api/stock/ajuste', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('productos')) return sinModulo(c, 'productos');
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador ajusta el stock.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const cantidad = texto(b.cantidad, 20);
    if (!/^-?\d+(\.\d+)?$/.test(cantidad)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Cantidad inválida: usa + para entrada y - para salida, por ejemplo -1.');
    try {
      const stock = await ajustarStock(d.db, s.empresa.id, texto(b.sku, 40), cantidad, texto(b.motivo, 200), s.usuarioId);
      return c.json({ ok: true, stock });
    } catch (e) {
      return negocio(c, e);
    }
  });

  // Proveedor ya conocido: con su RUC se completa la razón social.
  app.get('/panel/api/proveedores', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    const ruc = c.req.query('ruc') ?? '';
    if (!/^\d{11}$/.test(ruc)) return d.error(c, 400, 'DOCUMENTO_INVALIDO', 'RUC inválido.');
    const r = await d.db.query(`SELECT razon_social FROM proveedores WHERE empresa_id = $1 AND ruc = $2`, [s.empresa.id, ruc]);
    return r.rows[0] ? c.json({ razonSocial: r.rows[0].razon_social }) : d.error(c, 404, 'NO_ENCONTRADO', 'Proveedor nuevo.');
  });

  // ---------- Reposición y Kardex (costos: dueño, administrador y contador) ----------
  const conInventario = async (c: Context) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('productos')) return sinModulo(c, 'productos');
    return ROLES_COMPRAS.includes(s.empresa.rol) ? s : d.error(c, 403, 'SIN_PERMISO', 'Tu rol no ve costos ni reposición.');
  };

  app.get('/panel/api/reposicion', async (c) => {
    const s = await conInventario(c);
    if (s instanceof Response) return s;
    const proveedores = (await d.db.query(
      `SELECT ruc, razon_social, dias_entrega FROM proveedores WHERE empresa_id = $1 ORDER BY razon_social`, [s.empresa.id],
    )).rows.map((p) => ({ ruc: p.ruc, razonSocial: p.razon_social, diasEntrega: p.dias_entrega }));
    return c.json({ ...(await reposicion(d.db, s.empresa.id)), proveedores });
  });

  app.get('/panel/api/kardex', async (c) => {
    const s = await conInventario(c);
    if (s instanceof Response) return s;
    const k = await kardex(d.db, s.empresa.id, (c.req.query('sku') ?? '').slice(0, 40));
    if (!k) return d.error(c, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');
    if (c.req.query('formato') !== 'csv') return c.json(k);
    const lineas = [
      ['Fecha', 'Movimiento', 'Documento', 'Detalle', 'Entrada', 'Salida', 'Saldo', 'Costo unitario', 'Costo promedio', 'Valor del saldo'],
      ...k.movimientos.map((m) => [m.fecha, m.tipo, m.documento, m.detalle, m.entrada, m.salida, m.saldo, m.costoUnitario, m.costoPromedio, m.valorSaldo]),
    ];
    return c.body(csvParaExcel(lineas), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="kardex-${k.producto.sku}.csv"`,
    });
  });

  const dias = (v: unknown) => (typeof v === 'string' && /^\d{1,3}$/.test(v) && Number(v) <= 365 ? Number(v) : undefined);

  app.post('/panel/api/proveedores/dias', async (c) => {
    const s = await conInventario(c);
    if (s instanceof Response) return s;
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const n = dias(b.dias);
    if (n === undefined) return d.error(c, 422, 'DATOS_INVALIDOS', 'Días de entrega: un número de 0 a 365.');
    return (await guardarDiasEntrega(d.db, s.empresa.id, texto(b.ruc, 11), n))
      ? c.json({ ok: true })
      : d.error(c, 404, 'NO_ENCONTRADO', 'Ese proveedor no está registrado: aparece al registrar su primera compra.');
  });

  app.post('/panel/api/productos/proveedor', async (c) => {
    const s = await conInventario(c);
    if (s instanceof Response) return s;
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const ruc = texto(b.ruc, 11) || null;
    const n = texto(b.dias, 3) ? dias(b.dias) : null;
    if (n === undefined) return d.error(c, 422, 'DATOS_INVALIDOS', 'Días de entrega: un número de 0 a 365 (o vacío).');
    return (await asignarProveedor(d.db, s.empresa.id, texto(b.sku, 40), ruc, n))
      ? c.json({ ok: true })
      : d.error(c, 404, 'NO_ENCONTRADO', 'Revisa el código del producto y el RUC del proveedor (debe tener al menos una compra registrada).');
  });

  // Factura o boleta de un proveedor: suma al IGV de compras del mes (y al stock si es un producto).
  app.post('/panel/api/compras', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('compras')) return sinModulo(c, 'compras');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no registra compras.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const prov = (typeof b.proveedor === 'object' && b.proveedor ? b.proveedor : {}) as Record<string, unknown>;
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100).map((x: Record<string, unknown>) => ({
      ...(texto(x?.sku, 40) ? { sku: texto(x.sku, 40) } : {}),
      descripcion: texto(x?.descripcion, 250), cantidad: texto(x?.cantidad, 20) || '1', costoUnitario: texto(x?.costoUnitario, 20),
    }));
    const numero = Number(texto(b.numero, 10));
    const montos = [texto(b.igv, 20), texto(b.total, 20), ...items.flatMap((i) => [i.cantidad, i.costoUnitario])];
    if (montos.some((m) => !/^\d+(\.\d+)?$/.test(m))) return d.error(c, 422, 'DATOS_INVALIDOS', 'Revisa los montos: usa números con punto decimal, por ejemplo 118.00.');
    try {
      const r = await registrarCompra(d.db, s.empresa.id, {
        proveedor: { ruc: texto(prov.ruc, 11), razonSocial: texto(prov.razonSocial, 200) },
        tipoComprobante: b.tipo === '03' ? '03' : '01',
        serie: texto(b.serie, 4), numero, fecha: texto(b.fecha, 10),
        igv: texto(b.igv, 20), total: texto(b.total, 20), items,
      }, s.usuarioId);
      return c.json({ ok: true, ...r }, 201);
    } catch (e) {
      return negocio(c, e);
    }
  });

  app.get('/panel/api/compras', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('compras')) return sinModulo(c, 'compras');
    const r = await d.db.query(
      `SELECT c.fecha_emision::text AS fecha, c.serie, c.numero, p.razon_social AS proveedor, c.igv::text AS igv, c.total::text AS total
         FROM compras c JOIN proveedores p ON p.id = c.proveedor_id
        WHERE c.empresa_id = $1 AND c.anulada_en IS NULL ORDER BY c.creado_en DESC LIMIT 20`,
      [s.empresa.id],
    );
    return c.json({ compras: r.rows.map((x) => ({ ...x, numero: `${x.serie}-${x.numero}` })) });
  });

  // Cobro de una venta al crédito o de un saldo (ej. el 50% al entregar).
  app.post('/panel/api/comprobantes/:id/pagos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    if (!ROLES_EMISORES.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no registra cobros.');
    const id = await deLaEmpresa(s.empresa.id, c.req.param('id'));
    if (!id) return d.error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const medio = texto(b.medio, 20).toUpperCase() as MedioPago;
    if (!MEDIOS_PAGO.includes(medio)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Elige el medio de pago.');
    const monto = texto(b.monto, 20);
    if (monto && !/^\d+(\.\d{1,2})?$/.test(monto)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Monto inválido, por ejemplo 150.00.');
    const referencia = texto(b.referencia, 60);
    const cuenta = texto(b.cuenta, 36);
    if (cuenta && !UUID.test(cuenta)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Cuenta inválida.');
    const r = await registrarPago(d.db, {
      empresaId: s.empresa.id, comprobanteId: id, medio, usuarioId: s.usuarioId,
      ...(monto ? { monto } : {}), ...(referencia ? { referencia } : {}), ...(cuenta ? { cuentaId: cuenta } : {}),
    });
    if (r.resultado === 'ERROR') return d.error(c, 422, 'PAGO_INVALIDO', r.errores.join(' '));
    return c.json(await d.respuestaComprobante(c, id), r.resultado === 'REGISTRADO' ? 201 : 200);
  });

  // ---------- Cuentas donde entra el dinero y caja ----------
  app.get('/panel/api/cuentas', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    const cuentas = await listarCuentas(d.db, s.empresa.id);
    // Quien solo vende ve las activas (para elegir dónde entró el dinero).
    return c.json({ cuentas: ROLES_CORRIGEN.includes(s.empresa.rol) ? cuentas : cuentas.filter((x) => x.activa) });
  });

  const guardarCuentaRuta = async (c: Context, id?: string) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador cambia las cuentas.');
    if (id !== undefined && !UUID.test(id)) return d.error(c, 404, 'NO_ENCONTRADO', 'Cuenta no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const cuentaId = await guardarCuenta(d.db, s.empresa.id, {
        ...(id ? { id } : {}), nombre: texto(b.nombre, 60), medio: texto(b.medio, 20).toUpperCase(),
        ...(typeof b.titular === 'string' || b.titular === null ? { titular: texto(b.titular, 120) } : {}),
        deLaEmpresa: b.deLaEmpresa !== false, predeterminada: b.predeterminada === true, ...(typeof b.activa === 'boolean' ? { activa: b.activa } : {}),
      }, s.usuarioId);
      return c.json({ ok: true, id: cuentaId }, id ? 200 : 201);
    } catch (e) {
      if (e instanceof ErrorCuenta) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  };
  app.post('/panel/api/cuentas', (c) => guardarCuentaRuta(c));
  app.post('/panel/api/cuentas/:id', (c) => guardarCuentaRuta(c, c.req.param('id')));

  app.get('/panel/api/caja', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no ve la caja.');
    const hoy = ahoraLima().fecha;
    const desde = c.req.query('desde') ?? hoy;
    const hasta = c.req.query('hasta') ?? hoy;
    if (!esFecha(desde) || !esFecha(hasta) || desde > hasta) return d.error(c, 400, 'FECHAS_INVALIDAS', 'Fechas como AAAA-MM-DD, "desde" antes de "hasta".');
    return c.json(await caja(d.db, s.empresa.id, desde, hasta));
  });

  // Gastos y caja chica: el dinero que sale. Quien vende puede anotarlo (pagó el pasaje con el
  // efectivo del cajón); verlos y anularlos es de quien ve la caja.
  app.get('/panel/api/gastos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no ve los gastos.');
    const hoy = ahoraLima().fecha;
    const desde = c.req.query('desde') ?? hoy;
    const hasta = c.req.query('hasta') ?? hoy;
    if (!esFecha(desde) || !esFecha(hasta) || desde > hasta) return d.error(c, 400, 'FECHAS_INVALIDAS', 'Fechas como AAAA-MM-DD, "desde" antes de "hasta".');
    return c.json({ ...(await gastosDelPeriodo(d.db, s.empresa.id, desde, hasta)), categorias: CATEGORIAS_GASTO });
  });
  app.post('/panel/api/gastos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    if (!ROLES_EMISORES.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no registra gastos.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const hoy = ahoraLima().fecha;
    try {
      const id = await registrarGasto(d.db, s.empresa.id, {
        fecha: texto(b.fecha, 10) || hoy, monto: texto(b.monto, 20).replace(',', '.'), categoria: texto(b.categoria, 20).toUpperCase(),
        descripcion: texto(b.descripcion, 200), medio: texto(b.medio, 20).toUpperCase(),
        ...(typeof b.cuenta === 'string' && UUID.test(b.cuenta) ? { cuentaId: b.cuenta } : {}),
        ...(typeof b.documento === 'string' ? { documento: b.documento } : {}),
      }, s.usuarioId, hoy);
      return c.json({ ok: true, id }, 201);
    } catch (e) {
      if (e instanceof ErrorGasto) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });
  app.post('/panel/api/gastos/:id/anular', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador anula gastos.');
    const id = c.req.param('id');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return UUID.test(id) && (await anularGasto(d.db, s.empresa.id, id, texto(b.motivo, 200), s.usuarioId))
        ? c.json({ ok: true }) : d.error(c, 409, 'NO_SE_PUEDE', 'Ese gasto no existe o ya estaba anulado.');
    } catch (e) {
      if (e instanceof ErrorGasto) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Cierre de caja diario: lo esperado lo calcula el servidor; el usuario solo pone lo contado.
  const sesionCaja = async (c: Context) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no cierra la caja.');
    return s;
  };
  app.get('/panel/api/caja/cierre', async (c) => {
    const s = await sesionCaja(c);
    if (s instanceof Response) return s;
    const hoy = ahoraLima().fecha;
    const fecha = c.req.query('fecha') ?? hoy;
    if (!esFecha(fecha) || fecha > hoy) return d.error(c, 400, 'FECHA_INVALIDA', 'Elige un día de hoy hacia atrás (AAAA-MM-DD).');
    const hace30 = sumarDias(hoy, -30);
    // Del historial, solo el último cierre de cada día (los anteriores quedaron reemplazados).
    const historial = (await cierresDeCaja(d.db, s.empresa.id, hace30, hoy)).filter((x, i, todos) => todos.findIndex((y) => y.fecha === x.fecha) === i);
    return c.json({
      fecha,
      lineas: await lineasParaCerrar(d.db, s.empresa.id, fecha),
      cierres: await cierresDeCaja(d.db, s.empresa.id, fecha, fecha),
      historial,
    });
  });
  app.post('/panel/api/caja/cierre', async (c) => {
    const s = await sesionCaja(c);
    if (s instanceof Response) return s;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const fecha = texto(b.fecha, 10);
    if (!esFecha(fecha)) return d.error(c, 400, 'FECHA_INVALIDA', 'Fecha como AAAA-MM-DD.');
    const mapa = (v: unknown) => {
      const m: Record<string, string> = {};
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) if (typeof x === 'string') m[k.slice(0, 60)] = x.trim();
      return m;
    };
    const contados = mapa(b.contados);
    try {
      return c.json(await cerrarCaja(d.db, s.empresa.id, fecha, contados, texto(b.nota, 300) || null, s.usuarioId, ahoraLima().fecha, mapa(b.fondos)), 201);
    } catch (e) {
      if (e instanceof ErrorCuenta) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  app.get('/panel/api/por-cobrar', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    const r = await d.db.query(
      `SELECT c.id, c.serie, c.numero, c.cliente_nombre, c.fecha_emision::text AS fecha, ${sqlSaldo('c')}::numeric(14,2)::text AS saldo,
              (SELECT min(q.fecha_vencimiento)::text FROM comprobante_cuotas q WHERE q.comprobante_id = c.id AND NOT q.pagada) AS proxima_cuota,
              k.telefono AS celular, c.cliente_tipo_doc, c.cliente_numero_doc
         FROM comprobantes c LEFT JOIN clientes k ON k.id = c.cliente_id
        WHERE c.empresa_id = $1 AND c.tipo_comprobante <> '07' AND c.estado_pago <> 'PAGADO' AND c.estado NOT IN ('RECHAZADO', 'ANULADO')
        ORDER BY proxima_cuota NULLS LAST, c.fecha_emision LIMIT 50`,
      [s.empresa.id],
    );
    return c.json({ porCobrar: r.rows.map((x) => ({ id: x.id, numero: idComprobanteLegible(x.serie, Number(x.numero)), cliente: x.cliente_nombre, fecha: x.fecha, saldo: x.saldo, proximaCuota: x.proxima_cuota,
      celular: x.celular, documento: { tipoDocumento: x.cliente_tipo_doc, numero: x.cliente_numero_doc } })) });
  });

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

  // ---------- Plataforma: tus clientes, sus planes y la salud del sistema ----------
  // Solo para administradores de la plataforma (npm run usuario -- plataforma --email …).
  const conPlataforma = async (c: Context) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    return s.adminPlataforma ? s : d.error(c, 403, 'SIN_PERMISO', 'Solo el administrador de la plataforma.');
  };
  const empresaDeRuta = async (c: Context) => {
    const id = c.req.param('empresaId') ?? '';
    return UUID.test(id) && (await d.db.query(`SELECT 1 FROM empresas WHERE id = $1`, [id])).rowCount ? id : undefined;
  };

  app.get('/panel/api/plataforma', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const planes = (await d.db.query(
      `SELECT codigo, nombre, precio_mensual::text AS mensual, precio_anual::text AS anual, comprobantes_mes, usuarios_max, activo, secciones FROM planes ORDER BY precio_mensual`,
    )).rows.map((p) => ({
      codigo: p.codigo, nombre: p.nombre, mensual: p.mensual, anual: p.anual, comprobantesMes: p.comprobantes_mes, usuariosMax: p.usuarios_max, activo: p.activo, secciones: p.secciones,
    }));
    return c.json({ ...(await clientes(d.db)), planes, actividad: await actividadPlataforma(d.db) });
  });

  app.get('/panel/api/plataforma/salud', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    return c.json(await saludPlataforma(d.db));
  });

  app.post('/panel/api/plataforma/:empresaId/pago', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const empresaId = await empresaDeRuta(c);
    if (!empresaId) return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const r = await registrarPagoPlan(d.db, {
        empresaId, usuarioId: s.usuarioId, periodo: texto(b.periodo, 10) as 'MENSUAL' | 'ANUAL', medio: texto(b.medio, 60),
        ...(texto(b.monto, 12) ? { monto: texto(b.monto, 12) } : {}), ...(texto(b.referencia, 120) ? { referencia: texto(b.referencia, 120) } : {}),
        ...(texto(b.plan, 20) ? { plan: texto(b.plan, 20) } : {}),
      });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof ErrorSuscripcion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  app.post('/panel/api/plataforma/:empresaId/cambio', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const empresaId = await empresaDeRuta(c);
    if (!empresaId) return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      await cambiarSuscripcion(d.db, {
        empresaId, usuarioId: s.usuarioId, motivo: texto(b.motivo, 300),
        ...(texto(b.plan, 20) ? { plan: texto(b.plan, 20) } : {}),
        ...(texto(b.estado, 20) ? { estado: texto(b.estado, 20) as 'ACTIVA' | 'SUSPENDIDA' | 'CANCELADA' } : {}),
      });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof ErrorSuscripcion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Invitar al DUEÑO de la empresa de un cliente: recibe su enlace y configura todo él mismo.
  app.post('/panel/api/plataforma/:empresaId/invitar', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const empresaId = await empresaDeRuta(c);
    if (!empresaId) return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const r = await invitar(d.db, { email: texto(b.email, 200), nombre: texto(b.nombre, 120), empresaId, rol: 'DUENO', creadaPor: s.usuarioId });
      if (r.existente) return c.json({ ok: true, existente: true });
      const razon = (await d.db.query(`SELECT razon_social FROM empresas WHERE id = $1`, [empresaId])).rows[0].razon_social as string;
      const enlace = enlaceInvitacion(c, r.token);
      avisarInvitacion(texto(b.email, 200).toLowerCase(), enlace, razon);
      return c.json({ ok: true, existente: false, enlace, expira: r.expira, porCorreo: Boolean(d.correo) }, 201);
    } catch (e) {
      if (e instanceof ErrorInvitacion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Precios de los planes: los decide el dueño de la plataforma (los de fábrica son una propuesta).
  app.post('/panel/api/plataforma/planes/:codigo', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const monto = (v: unknown) => (typeof v === 'string' && /^\d{1,8}(\.\d{1,2})?$/.test(v) ? v : undefined);
    const entero = (v: unknown) => (v === null || v === '' ? null : typeof v === 'string' && /^[1-9]\d{0,6}$/.test(v) ? Number(v) : undefined);
    const mensual = monto(b.mensual);
    const anual = monto(b.anual);
    const comprobantes = entero(b.comprobantesMes);
    const usuarios = entero(b.usuariosMax);
    if (!mensual || !anual || comprobantes === undefined || usuarios === undefined) {
      return d.error(c, 422, 'DATOS_INVALIDOS', 'Precios como 39.00; límites como números enteros (vacío = sin límite).');
    }
    // Secciones del plan (opcional): solo las que se reparten por plan.
    const secciones = Array.isArray(b.secciones) ? b.secciones.filter((x): x is string => typeof x === 'string') : undefined;
    if (secciones && secciones.some((x) => !(SECCIONES_DE_PLAN as readonly string[]).includes(x))) {
      return d.error(c, 422, 'DATOS_INVALIDOS', `Secciones válidas: ${SECCIONES_DE_PLAN.join(', ')}.`);
    }
    const r = await d.db.query(
      `UPDATE planes SET precio_mensual = $2, precio_anual = $3, comprobantes_mes = $4, usuarios_max = $5, secciones = coalesce($6, secciones) WHERE codigo = $1 RETURNING 1`,
      [c.req.param('codigo'), mensual, anual, comprobantes, usuarios, secciones ?? null],
    );
    if (!r.rowCount) return d.error(c, 404, 'NO_ENCONTRADO', 'Plan no encontrado.');
    await d.db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, despues) VALUES ($1, 'CAMBIO_PLAN_PRECIOS', 'planes', $2)`, [
      s.usuarioId, JSON.stringify({ codigo: c.req.param('codigo'), mensual, anual, comprobantes, usuarios, secciones: secciones ?? null }),
    ]);
    return c.json({ ok: true });
  });

  // ---------- Reportes: "algo no funciona" o "me falta esto" ----------
  app.post('/panel/api/reportes', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const ip = d.ipCliente(c);
    // Cada reporte cuenta: frena a quien quiera llenar el correo del administrador.
    if (d.fallos.excedido(ip) || !d.fallos.contar(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const tipo = texto(b.tipo, 20) === 'SUGERENCIA' ? 'SUGERENCIA' : 'PROBLEMA';
    const mensaje = texto(b.mensaje, 2000).trim();
    if (mensaje.length < 5) return d.error(c, 422, 'DATOS_INVALIDOS', 'Cuéntanos un poco más (mínimo 5 letras).');
    const pantalla = texto(b.pantalla, 40) || null;
    await d.db.query(`INSERT INTO reportes (empresa_id, usuario_id, tipo, mensaje, pantalla) VALUES ($1, $2, $3, $4, $5)`, [
      s.empresa?.id ?? null, s.usuarioId, tipo, mensaje, pantalla,
    ]);
    const para = (await d.db.query(`SELECT lower(email) AS email FROM usuarios WHERE admin_plataforma AND activo`)).rows.map((x) => x.email as string);
    if (para.length) {
      void d.correo?.({
        para, asunto: `Facturador: ${tipo === 'PROBLEMA' ? '⚠️ problema reportado' : 'sugerencia'} de ${s.empresa?.razonSocial ?? s.nombre}`,
        texto: `${s.nombre} (${s.email})${s.empresa ? ` · ${s.empresa.razonSocial} (${s.empresa.ruc})` : ''}${pantalla ? ` · pantalla: ${pantalla}` : ''}\n\n${mensaje}\n\nMárcalo como atendido en el panel → Plataforma.`,
      }).catch((e: unknown) => console.error('[reportes] no se pudo enviar:', e instanceof Error ? e.message : e));
    }
    return c.json({ ok: true }, 201);
  });

  app.get('/panel/api/plataforma/reportes', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const r = await d.db.query(
      `SELECT r.id, r.tipo, r.mensaje, r.pantalla, r.creado_en, u.nombre, u.email, e.razon_social
         FROM reportes r JOIN usuarios u ON u.id = r.usuario_id LEFT JOIN empresas e ON e.id = r.empresa_id
        WHERE r.atendido_en IS NULL ORDER BY r.id DESC LIMIT 100`,
    );
    return c.json({ reportes: r.rows.map((x) => ({
      id: String(x.id), tipo: x.tipo, mensaje: x.mensaje, pantalla: x.pantalla, fecha: new Date(x.creado_en).toISOString(),
      usuario: `${x.nombre} (${x.email})`, empresa: x.razon_social,
    })) });
  });

  app.post('/panel/api/plataforma/reportes/:id/atendido', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const id = c.req.param('id');
    if (!/^\d{1,15}$/.test(id)) return d.error(c, 404, 'NO_ENCONTRADO', 'Reporte no encontrado.');
    const r = await d.db.query(`UPDATE reportes SET atendido_en = now(), atendido_por = $2 WHERE id = $1 AND atendido_en IS NULL RETURNING id`, [id, s.usuarioId]);
    return r.rowCount ? c.json({ ok: true }) : d.error(c, 404, 'NO_ENCONTRADO', 'Reporte no encontrado o ya atendido.');
  });

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
  // Invitar a una persona: si es nueva, recibe un ENLACE y ella misma pone su contraseña y su app.
  const enlaceInvitacion = (c: Context, token: string) => `${origenPropio(c)}/panel#invitacion=${token}`;
  const avisarInvitacion = (para: string, enlace: string, empresa: string) => {
    void d.correo?.({
      para: [para], asunto: `Te invitaron al facturador de ${empresa}`,
      texto: `Para entrar, abre este enlace (vale 72 horas) y crea tu contraseña:\n\n${enlace}\n\nTen a mano Google Authenticator en tu celular.`,
    }).catch((e: unknown) => console.error('[invitacion] no se pudo enviar:', e instanceof Error ? e.message : e));
  };

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
