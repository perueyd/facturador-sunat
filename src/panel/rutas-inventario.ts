/**
 * Rutas del panel · Inventario: stock, productos, proveedores, reposición, Kardex y compras.
 * Se registran desde rutas.ts, que arma la sesión y los ayudantes comunes (ver comun-rutas.ts).
 */
import type { Context, Hono } from 'hono';
import { registrarCompra } from '../inventario/compras.js';
import { ErrorInventario, ajustarStock, guardarProducto, listarStock } from '../inventario/productos.js';
import { asignarProveedor, guardarDiasEntrega, kardex, reposicion } from '../inventario/reposicion.js';
import { ErrorPorPagar, anularPagoCompra, pagarCompra, porPagar } from '../inventario/por-pagar.js';
import { ahoraLima } from '../fechas.js';
import { ROLES_CORRIGEN, ROLES_COMPRAS, UUID, csvParaExcel } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';

export function registrarInventario(app: Hono<any>, { d, conEmpresa, sinModulo, texto }: Comun): void {
  // ---------- Compras y stock ----------

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
        ...(texto(b.vence, 10) ? { vence: texto(b.vence, 10) } : {}),
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
      `SELECT c.fecha_emision::text AS fecha, c.serie, c.numero, p.razon_social AS proveedor, c.igv::text AS igv, c.total::text AS total, c.vence::text AS vence
         FROM compras c JOIN proveedores p ON p.id = c.proveedor_id
        WHERE c.empresa_id = $1 AND c.anulada_en IS NULL ORDER BY c.creado_en DESC LIMIT 20`,
      [s.empresa.id],
    );
    return c.json({ compras: r.rows.map((x) => ({ ...x, numero: `${x.serie}-${x.numero}` })) });
  });

  // ---------- Cuentas por pagar: lo que se debe a proveedores por compras al crédito ----------
  const conPorPagar = async (c: Context) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('compras')) return sinModulo(c, 'compras');
    return ROLES_COMPRAS.includes(s.empresa.rol) ? s : d.error(c, 403, 'SIN_PERMISO', 'Tu rol no ve ni paga deudas a proveedores.');
  };
  app.get('/panel/api/por-pagar', async (c) => {
    const s = await conPorPagar(c);
    if (s instanceof Response) return s;
    return c.json(await porPagar(d.db, s.empresa.id, ahoraLima().fecha));
  });
  app.post('/panel/api/compras/:id/pagos', async (c) => {
    const s = await conPorPagar(c);
    if (s instanceof Response) return s;
    const id = c.req.param('id');
    if (!UUID.test(id)) return d.error(c, 404, 'NO_ENCONTRADO', 'Compra no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const hoy = ahoraLima().fecha;
    try {
      const r = await pagarCompra(d.db, s.empresa.id, id, {
        medio: texto(b.medio, 20).toUpperCase(), fecha: texto(b.fecha, 10) || hoy,
        ...(texto(b.monto, 20) ? { monto: texto(b.monto, 20).replace(',', '.') } : {}),
        ...(typeof b.cuenta === 'string' && UUID.test(b.cuenta) ? { cuentaId: b.cuenta } : {}),
        ...(texto(b.referencia, 60) ? { referencia: texto(b.referencia, 60) } : {}),
      }, s.usuarioId, hoy);
      return c.json(r, 201);
    } catch (e) {
      if (e instanceof ErrorPorPagar) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });
  app.post('/panel/api/pagos-compra/:id/anular', async (c) => {
    const s = await conPorPagar(c);
    if (s instanceof Response) return s;
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador anula pagos.');
    const id = c.req.param('id');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return UUID.test(id) && (await anularPagoCompra(d.db, s.empresa.id, id, texto(b.motivo, 200), s.usuarioId))
        ? c.json({ ok: true }) : d.error(c, 409, 'NO_SE_PUEDE', 'Ese pago no existe o ya estaba anulado.');
    } catch (e) {
      if (e instanceof ErrorPorPagar) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });
}
