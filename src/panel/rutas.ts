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
import { solicitarAnulacion } from '../comprobantes/anular.js';
import { esFormatoPdf, pdfDeComprobante } from '../comprobantes/pdf-comprobante.js';
import type { Db } from '../db/conexion.js';
import { MEDIOS_PAGO, registrarPago, sqlSaldo, type MedioPago } from '../cobros/pagos.js';
import { ErrorDevolucion, registrarDevolucion } from '../devoluciones/devoluciones.js';
import { registrarCompra } from '../inventario/compras.js';
import { ErrorInventario, ajustarStock, guardarProducto, listarStock } from '../inventario/productos.js';
import { ErrorPdf } from '../pdf/representacion.js';
import { tablero, type Modulo } from '../reportes/tablero.js';
import { idComprobanteLegible } from '../tipos.js';
import { ROLES_EMISORES, cambiarContrasena, elegirEmpresa, entrar, leerSesion, salir, type Rol, type Sesion } from './usuarios.js';

/** Notas de crédito, anulaciones, productos y stock: solo quienes responden por la empresa. */
const ROLES_CORRIGEN: readonly Rol[] = ['DUENO', 'ADMIN'];
/** Compras de proveedores: también el contador. */
const ROLES_COMPRAS: readonly Rol[] = ['DUENO', 'ADMIN', 'CONTADOR'];

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
    // Tasa vigente del IGV (parámetro con fecha de vigencia): solo para SUGERIR montos en el formulario.
    const igv = (await d.db.query(
      `SELECT valor::text FROM parametros_tributarios WHERE codigo = 'IGV_TASA' AND regimen IS NULL
         AND vigente_desde <= current_date AND (vigente_hasta IS NULL OR vigente_hasta >= current_date) ORDER BY vigente_desde DESC LIMIT 1`,
    )).rows[0]?.valor as string | undefined;
    return c.json({
      nombre: s.nombre, email: s.email, empresas: s.empresas, empresa: s.empresa ?? null, canales, igvTasa: igv ?? null,
      puedeEmitir: Boolean(s.empresa && ROLES_EMISORES.includes(s.empresa.rol)),
      puedeCorregir: Boolean(s.empresa && ROLES_CORRIGEN.includes(s.empresa.rol) && s.empresa.modulos.includes('notas')),
      puedeAdministrar: Boolean(s.empresa && ROLES_CORRIGEN.includes(s.empresa.rol)),
      puedeComprar: Boolean(s.empresa && ROLES_COMPRAS.includes(s.empresa.rol) && s.empresa.modulos.includes('compras')),
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

  // Productos guardados, para elegirlos al emitir en vez de escribirlos.
  app.get('/panel/api/productos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('productos')) return sinModulo(c, 'productos');
    const r = await d.db.query(
      `SELECT sku, nombre, precio_con_igv::numeric(14,2)::text AS precio FROM productos WHERE empresa_id = $1 AND activo ORDER BY nombre LIMIT 500`,
      [s.empresa.id],
    );
    return c.json({ productos: r.rows });
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
    // Una celda que empieza con = + - @ sería una fórmula en Excel: se neutraliza.
    const celda = (v: unknown) => {
      const t = String(v ?? '');
      const seguro = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
      return /[;"\n]/.test(seguro) ? `"${seguro.replaceAll('"', '""')}"` : seguro;
    };
    const lineas = [
      ['Fecha', 'Tipo', 'Número', 'Doc. cliente', 'Cliente', 'Base imponible', 'IGV', 'Total', 'Estado SUNAT', 'Pago', 'Canal'],
      ...r.rows.map((x) => [
        x.fecha, TIPOS[x.tipo_comprobante] ?? x.tipo_comprobante, idComprobanteLegible(x.serie, Number(x.numero)), x.cliente_numero_doc,
        x.cliente_nombre, x.base, x.igv, x.total, x.estado, x.pago, x.canal,
      ]),
    ];
    // BOM + punto y coma: así lo abre bien Excel en español.
    const csv = '\uFEFF' + lineas.map((l) => l.map(celda).join(';')).join('\r\n') + '\r\n';
    return c.body(csv, 200, {
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
    const r = await registrarPago(d.db, {
      empresaId: s.empresa.id, comprobanteId: id, medio, usuarioId: s.usuarioId,
      ...(monto ? { monto } : {}), ...(referencia ? { referencia } : {}),
    });
    if (r.resultado === 'ERROR') return d.error(c, 422, 'PAGO_INVALIDO', r.errores.join(' '));
    return c.json(await d.respuestaComprobante(c, id), r.resultado === 'REGISTRADO' ? 201 : 200);
  });

  app.get('/panel/api/por-cobrar', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('cobros')) return sinModulo(c, 'cobros');
    const r = await d.db.query(
      `SELECT c.id, c.serie, c.numero, c.cliente_nombre, c.fecha_emision::text AS fecha, ${sqlSaldo('c')}::numeric(14,2)::text AS saldo,
              (SELECT min(q.fecha_vencimiento)::text FROM comprobante_cuotas q WHERE q.comprobante_id = c.id AND NOT q.pagada) AS proxima_cuota
         FROM comprobantes c
        WHERE c.empresa_id = $1 AND c.tipo_comprobante <> '07' AND c.estado_pago <> 'PAGADO' AND c.estado NOT IN ('RECHAZADO', 'ANULADO')
        ORDER BY proxima_cuota NULLS LAST, c.fecha_emision LIMIT 50`,
      [s.empresa.id],
    );
    return c.json({ porCobrar: r.rows.map((x) => ({ id: x.id, numero: idComprobanteLegible(x.serie, Number(x.numero)), cliente: x.cliente_nombre, fecha: x.fecha, saldo: x.saldo, proximaCuota: x.proxima_cuota })) });
  });
}
