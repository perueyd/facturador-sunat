/**
 * Rutas del panel · Ventas: cotizaciones, venta rápida, clientes, exportar, devoluciones y anulaciones.
 * Se registran desde rutas.ts, que arma la sesión y los ayudantes comunes (ver comun-rutas.ts).
 */
import type { Context, Hono } from 'hono';
import { solicitarAnulacion } from '../comprobantes/anular.js';
import { ErrorDevolucion, registrarDevolucion } from '../devoluciones/devoluciones.js';
import { ahoraLima } from '../fechas.js';
import { clientesFrecuentes, guardarCelular, normalizarCelular } from '../reportes/cliente.js';
import { masVendidos } from '../reportes/venta-rapida.js';
import { ErrorCotizacion, anularCotizacion, cargarCotizacion, crearCotizacion, listarCotizaciones, marcarConvertida, pdfCotizacion, type Cotizacion } from '../cotizaciones/cotizaciones.js';
import { tokenCotizacion } from '../api/enlaces.js';
import { idComprobanteLegible } from '../tipos.js';
import { ROLES_EMISORES } from './usuarios.js';
import { ROLES_CORRIGEN, UUID, csvParaExcel, origenPropio } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';

export function registrarVentas(app: Hono<any>, { d, conEmpresa, deLaEmpresa, sinModulo, texto }: Comun): void {
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
}
