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
import { readFileSync } from 'node:fs';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Almacen } from '../almacen/almacen.js';
import { esFormatoPdf, pdfDeComprobante } from '../comprobantes/pdf-comprobante.js';
import type { Db } from '../db/conexion.js';
import { ErrorPdf } from '../pdf/representacion.js';
import { idComprobanteLegible } from '../tipos.js';
import { ROLES_EMISORES, elegirEmpresa, entrar, leerSesion, salir, type Sesion } from './usuarios.js';

const COOKIE = '__Host-panel';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El panel genera el número de pedido al abrir el formulario: pulsar dos veces no emite dos. */
const PEDIDO_PANEL = /^PANEL-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const leer = (archivo: string) => readFileSync(new URL(`./publico/${archivo}`, import.meta.url));
const ARCHIVOS = {
  'index.html': { contenido: leer('index.html'), tipo: 'text/html; charset=utf-8' },
  'app.js': { contenido: leer('app.js'), tipo: 'text/javascript; charset=utf-8' },
  'estilo.css': { contenido: leer('estilo.css'), tipo: 'text/css; charset=utf-8' },
} as const;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
}

/** Origen público de esta petición (detrás de Render llega por https aunque el servidor vea http). */
function origenPropio(c: Context): string {
  const url = new URL(c.req.url);
  return `${c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1)}://${url.host}`;
}

export function registrarPanel(app: Hono<any>, d: DependenciasPanel): void {
  const frenado = (c: Context) => d.error(c, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos fallidos; espera un minuto.');

  for (const [ruta, archivo] of [['/panel', 'index.html'], ['/panel/', 'index.html'], ['/panel/app.js', 'app.js'], ['/panel/estilo.css', 'estilo.css']] as const) {
    app.get(ruta, (c) =>
      c.body(new Uint8Array(ARCHIVOS[archivo].contenido), 200, {
        'Content-Type': ARCHIVOS[archivo].tipo,
        'Content-Security-Policy': CSP,
        'Cache-Control': 'no-cache',
      }),
    );
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

  app.post('/panel/api/entrar', async (c) => {
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const r = await entrar(d.db, {
      email: texto(b.email, 200), contrasena: texto(b.contrasena, 200), codigo: texto(b.codigo, 6).trim(),
      llaveMaestra: d.llaveMaestra, ip,
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

  app.get('/panel/api/yo', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const canales = s.empresa
      ? (await d.db.query(`SELECT nombre FROM canales WHERE empresa_id = $1 AND tipo = 'MANUAL' AND activo ORDER BY nombre`, [s.empresa.id])).rows.map((x) => x.nombre as string)
      : [];
    return c.json({
      nombre: s.nombre, email: s.email, empresas: s.empresas, empresa: s.empresa ?? null, canales,
      puedeEmitir: Boolean(s.empresa && ROLES_EMISORES.includes(s.empresa.rol)),
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
}
