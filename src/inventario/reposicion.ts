/**
 * Reposición e inventario: qué pedir, cuándo y cuánto, y el Kardex de cada producto.
 *
 *   venta diaria   = lo vendido en los últimos 30 días ÷ 30
 *   punto de pedido = venta diaria × días de entrega del proveedor + colchón (stock de seguridad)
 *   sugerido       = lo que alcanza para (días de entrega + 30 días) + colchón − stock actual
 *
 * Todo con decimales exactos. Las cantidades sugeridas se redondean hacia ARRIBA a unidades
 * enteras: es mejor que sobre una unidad a quedarse sin stock.
 */
import type { Db } from '../db/conexion.js';
import { dec, type Decimal } from '../dinero.js';
import { ahoraLima, sumarDias } from '../fechas.js';

export const DIAS_ANALISIS = 30;
/** Al pedir, que alcance para estos días después de que llegue el pedido. */
export const DIAS_COBERTURA = 30;
/** Sin movimiento en estos días: stock "dormido" (dinero parado). */
const DIAS_SIN_MOVIMIENTO = 60;

export type EstadoReposicion = 'AGOTADO' | 'PEDIR_YA' | 'PRONTO' | 'OK' | 'SIN_MOVIMIENTO';

export interface FilaReposicion {
  sku: string;
  nombre: string;
  stock: string;
  colchon: string;
  ventaDiaria: string;
  /** Días que alcanza el stock al ritmo de venta actual (null si no se vende). */
  diasQueAlcanza: number | null;
  /** Fecha aproximada en que se acaba. */
  seAgota: string | null;
  diasEntrega: number | null;
  proveedor: string | null;
  puntoPedido: string;
  sugerido: string;
  costoPromedio: string | null;
  valor: string;
  estado: EstadoReposicion;
}

export interface Reposicion {
  productos: FilaReposicion[];
  resumen: {
    valorInventario: string;
    aPedir: number;
    agotados: number;
    sinMovimiento: number;
    /** Días que dura el inventario al ritmo de venta (valor ÷ costo de lo vendido por día). */
    diasDeInventario: number | null;
    sinTiempoEntrega: number;
  };
}

// Ojo: en decimal.js, isPositive() es verdadero también para 0; por eso se compara con gt(0).
const entero = (d: Decimal) => d.toDecimalPlaces(0, 2 /* hacia arriba */);

export async function reposicion(db: Db, empresaId: string, hoy = ahoraLima().fecha): Promise<Reposicion> {
  const r = await db.query(
    `SELECT p.sku, p.nombre, p.stock_minimo::text AS colchon, p.costo_promedio::text AS costo,
            coalesce(p.dias_entrega, pr.dias_entrega) AS dias_entrega, pr.razon_social AS proveedor,
            coalesce(sum(m.cantidad), 0)::text AS stock,
            -- Vendido neto: ventas menos devoluciones y anulaciones de los últimos 30 días.
            coalesce(-sum(m.cantidad) FILTER (WHERE m.tipo IN ('VENTA', 'DEVOLUCION', 'ANULACION') AND m.creado_en >= $2::date - $3::int), 0)::text AS vendido,
            coalesce(-sum(m.cantidad * coalesce(m.costo_unitario, p.costo_promedio, 0))
              FILTER (WHERE m.tipo IN ('VENTA', 'DEVOLUCION', 'ANULACION') AND m.creado_en >= $2::date - $3::int), 0)::text AS costo_vendido,
            max(m.creado_en) >= $2::date - $4::int AS se_movio
       FROM productos p
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
       LEFT JOIN movimientos_stock m ON m.producto_id = p.id
      WHERE p.empresa_id = $1 AND p.activo AND p.controla_stock
      GROUP BY p.id, pr.id ORDER BY p.nombre`,
    [empresaId, hoy, DIAS_ANALISIS, DIAS_SIN_MOVIMIENTO],
  );
  let valorTotal = dec('0');
  let costoVendido = dec('0');
  const productos = r.rows.map((f): FilaReposicion => {
    const stock = dec(f.stock);
    const colchon = dec(f.colchon ?? '0');
    const vendido = dec(f.vendido);
    const diaria = vendido.gt(0) ? vendido.div(DIAS_ANALISIS) : dec('0');
    const diasEntrega = f.dias_entrega as number | null;
    const puntoPedido = diaria.times(diasEntrega ?? 0).plus(colchon);
    const costo = f.costo === null ? null : dec(f.costo);
    const valor = stock.gt(0) && costo ? stock.times(costo) : dec('0');
    valorTotal = valorTotal.plus(valor);
    costoVendido = costoVendido.plus(dec(f.costo_vendido));
    const alcanza = diaria.isZero() ? null : Math.floor(stock.gt(0) ? stock.div(diaria).toNumber() : 0);

    let estado: EstadoReposicion = 'OK';
    if (!stock.gt(0)) estado = 'AGOTADO';
    else if (stock.lte(puntoPedido)) estado = 'PEDIR_YA';
    else if (stock.lte(puntoPedido.plus(diaria.times(7)))) estado = 'PRONTO';
    else if (!f.se_movio) estado = 'SIN_MOVIMIENTO';

    const necesita = diaria.times((diasEntrega ?? 0) + DIAS_COBERTURA).plus(colchon).minus(stock);
    const sugerido = ['AGOTADO', 'PEDIR_YA', 'PRONTO'].includes(estado) && necesita.gt(0) ? entero(necesita) : dec('0');
    return {
      sku: f.sku, nombre: f.nombre, stock: stock.toString(), colchon: colchon.toString(), ventaDiaria: diaria.toDecimalPlaces(2).toString(),
      diasQueAlcanza: alcanza, seAgota: alcanza === null ? null : sumarDias(hoy, alcanza),
      diasEntrega, proveedor: f.proveedor ?? null, puntoPedido: entero(puntoPedido).toString(), sugerido: sugerido.toString(),
      costoPromedio: costo ? costo.toFixed(2) : null, valor: valor.toFixed(2), estado,
    };
  });
  const orden: Record<EstadoReposicion, number> = { AGOTADO: 0, PEDIR_YA: 1, PRONTO: 2, SIN_MOVIMIENTO: 3, OK: 4 };
  productos.sort((a, b) => orden[a.estado] - orden[b.estado] || a.nombre.localeCompare(b.nombre));
  const costoDiario = costoVendido.div(DIAS_ANALISIS);
  return {
    productos,
    resumen: {
      valorInventario: valorTotal.toFixed(2),
      aPedir: productos.filter((p) => p.estado === 'AGOTADO' || p.estado === 'PEDIR_YA').length,
      agotados: productos.filter((p) => p.estado === 'AGOTADO').length,
      sinMovimiento: productos.filter((p) => p.estado === 'SIN_MOVIMIENTO').length,
      diasDeInventario: costoDiario.gt(0) ? Math.round(valorTotal.div(costoDiario).toNumber()) : null,
      sinTiempoEntrega: productos.filter((p) => p.diasEntrega === null).length,
    },
  };
}

export interface FilaKardex {
  fecha: string;
  tipo: string;
  documento: string | null;
  detalle: string | null;
  entrada: string | null;
  salida: string | null;
  saldo: string;
  costoUnitario: string | null;
  costoPromedio: string | null;
  valorSaldo: string;
}

/**
 * Kardex valorizado a costo promedio ponderado (control interno). Cada compra recalcula el
 * costo promedio; las salidas se valorizan al promedio del momento. No reemplaza al formato
 * oficial del registro de inventario de SUNAT (eso lo revisa el contador).
 */
export async function kardex(db: Db, empresaId: string, sku: string): Promise<{ producto: { sku: string; nombre: string }; movimientos: FilaKardex[] } | undefined> {
  const p = (await db.query(`SELECT id, sku, nombre FROM productos WHERE empresa_id = $1 AND sku = $2`, [empresaId, sku.trim().toUpperCase()])).rows[0];
  if (!p) return undefined;
  const r = await db.query(
    `SELECT m.creado_en, m.tipo::text AS tipo, m.cantidad::text, m.costo_unitario::text AS costo, m.motivo,
            c.serie || '-' || c.numero AS comprobante, k.serie || '-' || k.numero AS compra, pv.razon_social AS proveedor
       FROM movimientos_stock m
       LEFT JOIN comprobantes c ON c.id = m.comprobante_id
       LEFT JOIN compras k ON k.id = m.compra_id
       LEFT JOIN proveedores pv ON pv.id = k.proveedor_id
      WHERE m.producto_id = $1 ORDER BY m.creado_en, m.id`,
    [p.id],
  );
  let saldo = dec('0');
  let valor = dec('0');
  const movimientos = r.rows.map((m): FilaKardex => {
    const cant = dec(m.cantidad);
    const promedio = saldo.gt(0) ? valor.div(saldo) : null;
    if (cant.gt(0)) {
      // Entrada: con costo (compra) cambia el promedio; sin costo (devolución, ajuste) entra al promedio actual.
      const unitario = m.costo !== null ? dec(m.costo) : promedio ?? dec('0');
      valor = valor.plus(cant.times(unitario));
    } else {
      valor = valor.minus(cant.abs().times(promedio ?? dec('0')));
    }
    saldo = saldo.plus(cant);
    if (!saldo.gt(0)) valor = dec('0');
    const nuevoPromedio = saldo.gt(0) ? valor.div(saldo) : null;
    return {
      fecha: ahoraLima(new Date(m.creado_en)).fecha,
      tipo: m.tipo,
      documento: m.comprobante ?? (m.compra ? `${m.compra}${m.proveedor ? ` · ${m.proveedor}` : ''}` : null),
      detalle: m.motivo ?? null,
      entrada: cant.gt(0) ? cant.toString() : null,
      salida: cant.isNegative() ? cant.abs().toString() : null,
      saldo: saldo.toString(),
      costoUnitario: m.costo !== null ? dec(m.costo).toFixed(2) : null,
      costoPromedio: nuevoPromedio ? nuevoPromedio.toFixed(2) : null,
      valorSaldo: valor.toFixed(2),
    };
  });
  return { producto: { sku: p.sku, nombre: p.nombre }, movimientos };
}

/** Tiempo de entrega de un proveedor (días). */
export async function guardarDiasEntrega(db: Db, empresaId: string, ruc: string, dias: number): Promise<boolean> {
  const r = await db.query(`UPDATE proveedores SET dias_entrega = $3 WHERE empresa_id = $1 AND ruc = $2 RETURNING 1`, [empresaId, ruc, dias]);
  return Boolean(r.rowCount);
}

/** Proveedor habitual de un producto (y, si tarda distinto que el resto, sus propios días). */
export async function asignarProveedor(db: Db, empresaId: string, sku: string, ruc: string | null, diasEntrega: number | null): Promise<boolean> {
  const r = await db.query(
    `UPDATE productos SET proveedor_id = (SELECT id FROM proveedores WHERE empresa_id = $1 AND ruc = $3), dias_entrega = $4
      WHERE empresa_id = $1 AND sku = $2 AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM proveedores WHERE empresa_id = $1 AND ruc = $3)) RETURNING 1`,
    [empresaId, sku.trim().toUpperCase(), ruc, diasEntrega],
  );
  return Boolean(r.rowCount);
}
