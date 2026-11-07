/**
 * Devoluciones: en un solo paso se emite la nota de crédito, el producto vuelve al
 * stock (o se descarta si llegó dañado) y, si se devolvió dinero, se registra el
 * reembolso.
 *
 *   - Solo sobre facturas o boletas ACEPTADAS por SUNAT.
 *   - Nunca se devuelve más de lo vendido menos lo ya devuelto (por ítem).
 *   - Si el comprobante tuvo descuento global, la nota se calcula con los precios
 *     rebajados: se devuelve lo que el cliente pagó, no el precio de lista. Una
 *     devolución total devuelve exactamente el importe del comprobante.
 *   - Reintentar es seguro: la nota de crédito lleva una clave por devolución, así
 *     que un corte a mitad no emite dos notas.
 * El stock lo mueve la propia nota (motivos 06/07); si SUNAT la rechaza, se revierte.
 */
import type { MedioPago } from '../cobros/pagos.js';
import { emitirComprobante } from '../comprobantes/emitir.js';
import { cargarComprobante } from '../comprobantes/repositorio.js';
import pg from 'pg';
import { enTransaccion, type Db } from '../db/conexion.js';
import { Decimal, dec, redondear, sumar } from '../dinero.js';
import { ahoraLima } from '../fechas.js';
import { revisarStock } from '../inventario/stock.js';
import { TipoComprobante, idComprobanteLegible } from '../tipos.js';

export interface DatosDevolucion {
  empresaId: string;
  comprobanteId: string;
  motivo: string;
  /** `orden` es el número de línea del comprobante (1, 2, …). */
  items: { orden: number; cantidad: string; danado?: boolean }[];
  /** Dinero devuelto al cliente. Sin `monto`, el total de la nota de crédito. */
  reembolso?: { medio: MedioPago; monto?: string; referencia?: string; cuentaId?: string };
  usuarioId?: string;
}

export class ErrorDevolucion extends Error {}

export interface DevolucionRegistrada {
  devolucionId: string;
  notaCreditoId: string;
  notaCredito: string;
  total: string;
  tipo: 'TOTAL' | 'PARCIAL';
}

export async function registrarDevolucion(db: Db, d: DatosDevolucion): Promise<DevolucionRegistrada> {
  if (!d.motivo.trim()) throw new ErrorDevolucion('Indica el motivo de la devolución (lo verá SUNAT en la nota de crédito).');
  if (d.items.length === 0) throw new ErrorDevolucion('Indica qué productos se devuelven.');

  // Un candado por comprobante: dos devoluciones del mismo comprobante a la vez no
  // pueden pasar ambas el control de "cuánto queda por devolver". El candado va en una
  // conexión PROPIA, fuera del grupo compartido: antes tomaba una de las 10 del grupo y,
  // mientras la tenía, pedía otras; con 10 devoluciones a la vez se esperaban entre sí y
  // el servidor se colgaba (mismo error que se halló en la prueba de carga del 05/11/2026).
  const candado = new pg.Client(db.options);
  await candado.connect();
  try {
    await candado.query('SELECT pg_advisory_lock(hashtext($1))', [`devolucion:${d.comprobanteId}`]);
    return await registrarConCandado(db, d);
  } finally {
    // Cerrar la conexión suelta el candado aunque algo haya fallado.
    await candado.end().catch(() => undefined);
  }
}

async function registrarConCandado(db: Db, d: DatosDevolucion): Promise<DevolucionRegistrada> {
  const orig = await db.query(
    `SELECT empresa_id, canal_id, marca_id, estado::text, tipo_comprobante FROM comprobantes WHERE id = $1 AND empresa_id = $2`,
    [d.comprobanteId, d.empresaId],
  );
  const o = orig.rows[0];
  if (!o) throw new ErrorDevolucion('No existe ese comprobante en esta empresa.');
  const { comprobante: c } = await cargarComprobante(db, d.comprobanteId);
  const nombre = idComprobanteLegible(c.serie, c.numero);
  if (c.tipo !== TipoComprobante.FACTURA && c.tipo !== TipoComprobante.BOLETA) throw new ErrorDevolucion('Solo se devuelven productos de facturas o boletas.');
  if (o.estado !== 'ACEPTADO' && o.estado !== 'ACEPTADO_OBS') {
    throw new ErrorDevolucion(`${nombre} está ${o.estado.toLowerCase()}: la devolución se hace cuando SUNAT lo haya aceptado.`);
  }

  // Lo ya devuelto por línea (devoluciones cuya nota de crédito sigue vigente).
  const previas = await db.query(
    `SELECT di.item_orden, sum(di.cantidad)::text AS cantidad
     FROM devolucion_items di JOIN devoluciones dv ON dv.id = di.devolucion_id
     JOIN comprobantes nc ON nc.id = dv.nota_credito_id
     WHERE dv.comprobante_origen_id = $1 AND nc.estado NOT IN ('RECHAZADO', 'ANULADO')
     GROUP BY di.item_orden`,
    [d.comprobanteId],
  );
  const devuelto = new Map(previas.rows.map((f) => [Number(f.item_orden), dec(f.cantidad as string)]));
  const hayPrevias = previas.rows.length > 0;

  const pedidos = new Map<number, { cantidad: Decimal; danado: boolean }>();
  for (const it of d.items) {
    const linea = c.items[it.orden - 1];
    if (!linea) throw new ErrorDevolucion(`${nombre} no tiene la línea ${it.orden}.`);
    if (pedidos.has(it.orden)) throw new ErrorDevolucion(`La línea ${it.orden} está repetida.`);
    const cantidad = dec(it.cantidad);
    const disponible = linea.cantidad.minus(devuelto.get(it.orden) ?? 0);
    if (cantidad.lte(0)) throw new ErrorDevolucion(`Línea ${it.orden}: la cantidad debe ser mayor que cero.`);
    if (cantidad.gt(disponible)) {
      throw new ErrorDevolucion(`Línea ${it.orden} (${linea.descripcion}): solo quedan ${disponible.toString()} por devolver.`);
    }
    pedidos.set(it.orden, { cantidad, danado: Boolean(it.danado) });
  }

  // ¿Se devuelve TODO lo vendido, de una vez? Entonces es una devolución total.
  const total = !hayPrevias && c.items.every((l, i) => pedidos.get(i + 1)?.cantidad.eq(l.cantidad));

  // Con descuento global, cada línea vale (lo cobrado / suma de las líneas).
  const sumaLineas = sumar(c.items.map((l) => l.total));
  const factor = c.totales.importeTotal.div(sumaLineas);
  const ordenes = [...pedidos.keys()].sort((a, b) => a - b);
  const montos = ordenes.map((orden) => {
    const linea = c.items[orden - 1]!;
    return redondear(linea.total.times(pedidos.get(orden)!.cantidad.div(linea.cantidad)).times(factor));
  });
  if (total) {
    // Los redondeos por línea no deben dejar ni un céntimo de más o de menos.
    const diferencia = c.totales.importeTotal.minus(sumar(montos));
    montos[montos.length - 1] = montos[montos.length - 1]!.plus(diferencia);
  }

  const items = ordenes.map((orden, i) => {
    const linea = c.items[orden - 1]!;
    const cantidad = pedidos.get(orden)!.cantidad;
    return {
      ...(linea.codigo ? { codigo: linea.codigo } : {}),
      descripcion: linea.descripcion,
      unidad: linea.unidad,
      cantidad: cantidad.toString(),
      precioUnitarioConIgv: montos[i]!.div(cantidad).toDecimalPlaces(10).toString(),
      afectacion: linea.afectacion,
    };
  });

  const ncSerie = c.tipo === TipoComprobante.FACTURA ? 'FC01' : 'BC01';
  const n = await db.query(`SELECT count(*)::int AS n FROM devoluciones WHERE comprobante_origen_id = $1`, [d.comprobanteId]);
  const hoy = ahoraLima();
  const emitido = await emitirComprobante(db, {
    empresaId: d.empresaId,
    canalId: o.canal_id,
    ...(o.marca_id ? { marcaId: o.marca_id as string } : {}),
    // Clave de la devolución: si algo se corta después de emitir la nota, reintentar
    // encuentra la misma nota en vez de emitir otra.
    pedidoExternoId: `DEV-${d.comprobanteId}-${(n.rows[0].n as number) + 1}`,
    ...(d.usuarioId ? { usuarioId: d.usuarioId } : {}),
    solicitud: {
      tipo: TipoComprobante.NOTA_CREDITO,
      serie: ncSerie,
      fechaEmision: hoy.fecha,
      horaEmision: hoy.hora,
      cliente: c.cliente,
      items,
      formaPago: { tipo: 'CONTADO' },
      notaCredito: {
        referencia: { tipo: c.tipo, serie: c.serie, numero: c.numero },
        motivoCodigo: total ? '06' : '07',
        motivoDescripcion: d.motivo.trim().slice(0, 250),
      },
    },
  });
  if (emitido.resultado === 'ERROR_VALIDACION') throw new ErrorDevolucion(emitido.errores.join(' '));
  const nc = emitido.guardado;
  const totalNc = nc.comprobante.totales.importeTotal;
  if (emitido.resultado === 'REPETIDO' && !totalNc.eq(sumar(montos))) {
    throw new ErrorDevolucion(
      `Ya hay una nota de crédito ${idComprobanteLegible(nc.comprobante.serie, nc.comprobante.numero)} sin registrar de un intento anterior, por otro monto. Revísala antes de continuar.`,
    );
  }

  let reembolso: Decimal | undefined;
  if (d.reembolso) {
    reembolso = d.reembolso.monto === undefined ? totalNc : dec(d.reembolso.monto);
    if (reembolso.lte(0) || reembolso.gt(totalNc)) {
      throw new ErrorDevolucion(`El reembolso debe ser mayor que cero y no pasar de la nota de crédito (S/ ${totalNc.toFixed(2)}).`);
    }
  }

  const devolucionId = await enTransaccion(db, async (tx) => {
    const dv = await tx.query(
      `INSERT INTO devoluciones (empresa_id, comprobante_origen_id, nota_credito_id, tipo, motivo, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [d.empresaId, d.comprobanteId, nc.id, total ? 'TOTAL' : 'PARCIAL', d.motivo.trim(), d.usuarioId ?? null],
    );
    const id = dv.rows[0].id as string;
    const danados: string[] = [];
    for (const orden of ordenes) {
      const p = pedidos.get(orden)!;
      await tx.query(
        `INSERT INTO devolucion_items (devolucion_id, item_orden, cantidad, destino) VALUES ($1, $2, $3, $4)`,
        [id, orden, p.cantidad.toString(), p.danado ? 'DANADO' : 'REINGRESO'],
      );
      if (!p.danado) continue;
      // La nota de crédito ya lo regresó al stock; dañado no se puede vender, así que sale
      // con un ajuste ligado a la nota (si SUNAT la rechaza, también se revierte).
      const prod = await tx.query(
        `SELECT ci.producto_id FROM comprobante_items ci JOIN productos pr ON pr.id = ci.producto_id
         WHERE ci.comprobante_id = $1 AND ci.orden = $2 AND pr.controla_stock`,
        [d.comprobanteId, orden],
      );
      if (!prod.rows[0]) continue;
      await tx.query(
        `INSERT INTO movimientos_stock (empresa_id, producto_id, tipo, cantidad, comprobante_id, motivo, usuario_id)
         VALUES ($1, $2, 'AJUSTE', $3, $4, $5, $6)`,
        [d.empresaId, prod.rows[0].producto_id, p.cantidad.neg().toString(), nc.id, `Devuelto dañado (${nombre})`, d.usuarioId ?? null],
      );
      danados.push(prod.rows[0].producto_id as string);
    }
    await revisarStock(tx, d.empresaId, danados);
    if (d.reembolso && reembolso) {
      // De qué cuenta salió: la elegida (manda su medio) o la predeterminada del medio, como los cobros.
      const cuenta = (await tx.query(
        d.reembolso.cuentaId
          ? `SELECT id, medio::text FROM cuentas_cobro WHERE empresa_id = $1 AND id = $2::uuid AND activa`
          : `SELECT id, medio::text FROM cuentas_cobro WHERE empresa_id = $1 AND medio = $2 AND predeterminada AND activa`,
        [d.empresaId, d.reembolso.cuentaId ?? d.reembolso.medio],
      )).rows[0];
      if (d.reembolso.cuentaId && !cuenta) throw new ErrorDevolucion('La cuenta de la que salió el dinero no existe o está desactivada.');
      await tx.query(
        `INSERT INTO reembolsos (empresa_id, devolucion_id, monto, medio, referencia, fecha, usuario_id, cuenta_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [d.empresaId, id, reembolso.toFixed(2), cuenta?.medio ?? d.reembolso.medio, d.reembolso.referencia ?? null, hoy.fecha, d.usuarioId ?? null, cuenta?.id ?? null],
      );
    }
    await tx.query(
      `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'REGISTRAR_DEVOLUCION', 'devoluciones', $3, $4)`,
      [d.empresaId, d.usuarioId ?? null, id, JSON.stringify({ comprobante: nombre, notaCredito: nc.id, total: totalNc.toFixed(2), reembolso: reembolso?.toFixed(2) ?? null })],
    );
    return id;
  });

  return {
    devolucionId,
    notaCreditoId: nc.id,
    notaCredito: idComprobanteLegible(nc.comprobante.serie, nc.comprobante.numero),
    total: totalNc.toFixed(2),
    tipo: total ? 'TOTAL' : 'PARCIAL',
  };
}
