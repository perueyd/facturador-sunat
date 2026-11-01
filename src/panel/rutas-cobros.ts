/**
 * Rutas del panel · Cobros: pagos, cuentas, caja, gastos, cierre de caja y por cobrar.
 * Se registran desde rutas.ts, que arma la sesión y los ayudantes comunes (ver comun-rutas.ts).
 */
import type { Context, Hono } from 'hono';
import { CATEGORIAS_GASTO, ErrorGasto, anularGasto, gastosDelPeriodo, registrarGasto } from '../cobros/gastos.js';
import { ErrorCuenta, caja, cerrarCaja, cierresDeCaja, guardarCuenta, lineasParaCerrar, listarCuentas } from '../cobros/caja.js';
import { MEDIOS_PAGO, registrarPago, sqlSaldo, type MedioPago } from '../cobros/pagos.js';
import { ahoraLima, esFecha, sumarDias } from '../fechas.js';
import { idComprobanteLegible } from '../tipos.js';
import { ROLES_EMISORES } from './usuarios.js';
import { ROLES_CORRIGEN, ROLES_COMPRAS, UUID } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';

export function registrarCobros(app: Hono<any>, { d, conEmpresa, deLaEmpresa, sinModulo, texto }: Comun): void {
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
}
