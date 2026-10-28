/**
 * Estadísticas de ventas para el panel: cuánto se vendió hoy y en el mes, cómo va contra el
 * mes anterior, ticket promedio, clientes, gráficos (6 meses y 30 días), de qué canal vienen
 * las ventas y qué productos se venden más.
 *
 * Todo sale de los comprobantes: boletas y facturas suman, sus notas de crédito restan, y los
 * rechazados o anulados no cuentan. Los montos viajan como texto con 2 decimales. Para dibujar,
 * el alto de cada barra (0 a 100) lo calcula PostgreSQL con NUMERIC: el navegador no hace
 * cuentas de dinero.
 */
import type { Db } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { ahoraLima } from '../fechas.js';
import { listarStock } from '../inventario/productos.js';

const VALIDO = `estado NOT IN ('RECHAZADO', 'ANULADO')`;
const CON_SIGNO = `CASE WHEN tipo_comprobante = '07' THEN -importe_total ELSE importe_total END`;
/** DNI o RUC reales (las boletas sin documento no son un cliente identificable). */
const CLIENTE_IDENTIFICADO = `cliente_numero_doc ~ '^(\\d{8}|\\d{11})$' AND cliente_numero_doc !~ '^0+$'`;
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];

const soles = (v: unknown) => dec(String(v ?? '0')).toFixed(2);

export interface Estadisticas {
  hoy: { ventas: string; comprobantes: number };
  mes: {
    ventas: string;
    comprobantes: number;
    ticketPromedio: string;
    /** % contra los mismos días del mes anterior (null si el mes anterior no tuvo ventas). */
    variacion: string | null;
  };
  clientes: { mes: number; nuevos: number };
  /** Últimos 6 meses. `compras` solo si la empresa usa la función de compras. */
  meses: { periodo: string; nombre: string; ventas: string; alto: number; compras?: string; altoCompras?: number }[];
  dias: { fecha: string; ventas: string; alto: number }[];
  canales: { canal: string; ventas: string; porcentaje: number }[];
  productos: { descripcion: string; cantidad: string; ventas: string; alto: number }[];
  stockBajo?: number;
}

export async function estadisticas(
  db: Db,
  empresaId: string,
  opciones: { hoy?: string; compras?: boolean; productos?: boolean } = {},
): Promise<Estadisticas> {
  const hoy = opciones.hoy ?? ahoraLima().fecha;
  const p = [empresaId, hoy];

  const r = (await db.query(
    `SELECT
       coalesce(sum(${CON_SIGNO}) FILTER (WHERE fecha_emision = $2::date), 0)::text AS hoy,
       count(*) FILTER (WHERE fecha_emision = $2::date AND tipo_comprobante <> '07')::int AS hoy_n,
       coalesce(sum(${CON_SIGNO}) FILTER (WHERE fecha_emision >= date_trunc('month', $2::date)), 0)::text AS mes,
       count(*) FILTER (WHERE fecha_emision >= date_trunc('month', $2::date) AND tipo_comprobante <> '07')::int AS mes_n,
       -- Mismos días del mes anterior (del 1 al día de hoy): comparar contra el mes ENTERO
       -- haría que a inicio de mes siempre se viera una caída.
       coalesce(sum(${CON_SIGNO}) FILTER (WHERE fecha_emision >= date_trunc('month', $2::date) - interval '1 month'
                                          AND fecha_emision <= $2::date - interval '1 month'), 0)::text AS anterior
     FROM comprobantes
     WHERE empresa_id = $1 AND ${VALIDO} AND fecha_emision >= date_trunc('month', $2::date) - interval '1 month' AND fecha_emision <= $2::date`,
    p,
  )).rows[0];
  const ventasMes = dec(r.mes);
  const anterior = dec(r.anterior);

  const cl = (await db.query(
    `WITH del_mes AS (
       SELECT DISTINCT cliente_numero_doc AS doc FROM comprobantes
        WHERE empresa_id = $1 AND ${VALIDO} AND tipo_comprobante <> '07' AND ${CLIENTE_IDENTIFICADO}
          AND fecha_emision >= date_trunc('month', $2::date) AND fecha_emision <= $2::date)
     SELECT count(*)::int AS mes,
            count(*) FILTER (WHERE NOT EXISTS (
              SELECT 1 FROM comprobantes c WHERE c.empresa_id = $1 AND c.cliente_numero_doc = d.doc
                AND c.${VALIDO} AND c.fecha_emision < date_trunc('month', $2::date)))::int AS nuevos
       FROM del_mes d`,
    p,
  )).rows[0];

  const meses = (await db.query(
    `WITH m AS (
       SELECT to_char(d, 'YYYY-MM') AS periodo
         FROM generate_series(date_trunc('month', $2::date) - interval '5 months', date_trunc('month', $2::date), interval '1 month') d),
     v AS (
       SELECT to_char(fecha_emision, 'YYYY-MM') AS periodo, sum(${CON_SIGNO}) AS monto FROM comprobantes
        WHERE empresa_id = $1 AND ${VALIDO} AND fecha_emision >= date_trunc('month', $2::date) - interval '5 months' AND fecha_emision <= $2::date
        GROUP BY 1),
     c AS (
       SELECT periodo, sum(total) AS monto FROM compras WHERE empresa_id = $1 AND anulada_en IS NULL GROUP BY 1),
     t AS (
       SELECT m.periodo, coalesce(v.monto, 0) AS ventas, coalesce(c.monto, 0) AS compras
         FROM m LEFT JOIN v ON v.periodo = m.periodo LEFT JOIN c ON c.periodo = m.periodo)
     SELECT periodo, ventas::text, compras::text,
            -- Ventas y compras en la MISMA escala, para poder compararlas a simple vista.
            coalesce(round(greatest(ventas, 0) * 100 / nullif(greatest(max(ventas) OVER (), ${opciones.compras ? 'max(compras) OVER ()' : '0'}), 0)), 0)::int AS alto,
            coalesce(round(compras * 100 / nullif(greatest(max(ventas) OVER (), max(compras) OVER ()), 0)), 0)::int AS alto_compras
       FROM t ORDER BY periodo`,
    p,
  )).rows;

  const dias = (await db.query(
    `WITH d AS (SELECT dia::date AS fecha FROM generate_series($2::date - 29, $2::date, interval '1 day') dia),
     v AS (
       SELECT fecha_emision AS fecha, sum(${CON_SIGNO}) AS monto FROM comprobantes
        WHERE empresa_id = $1 AND ${VALIDO} AND fecha_emision > $2::date - 30 AND fecha_emision <= $2::date GROUP BY 1)
     SELECT d.fecha::text, coalesce(v.monto, 0)::text AS ventas,
            coalesce(round(greatest(coalesce(v.monto, 0), 0) * 100 / nullif(max(coalesce(v.monto, 0)) OVER (), 0)), 0)::int AS alto
       FROM d LEFT JOIN v ON v.fecha = d.fecha ORDER BY d.fecha`,
    p,
  )).rows;

  const canales = (await db.query(
    `WITH v AS (
       SELECT k.nombre AS canal, sum(${CON_SIGNO}) AS monto FROM comprobantes c JOIN canales k ON k.id = c.canal_id
        WHERE c.empresa_id = $1 AND c.${VALIDO} AND c.fecha_emision >= date_trunc('month', $2::date) AND c.fecha_emision <= $2::date
        GROUP BY 1)
     SELECT canal, monto::text AS ventas,
            coalesce(round(greatest(monto, 0) * 100 / nullif(sum(greatest(monto, 0)) OVER (), 0)), 0)::int AS porcentaje
       FROM v WHERE monto > 0 ORDER BY monto DESC`,
    p,
  )).rows;

  // Productos: solo boletas y facturas (una nota de crédito no dice qué producto se devolvió
  // con la misma descripción siempre).
  const productos = (await db.query(
    `WITH v AS (
       SELECT i.descripcion, sum(i.cantidad) AS cantidad, sum(i.total) AS monto
         FROM comprobante_items i JOIN comprobantes c ON c.id = i.comprobante_id
        WHERE c.empresa_id = $1 AND c.${VALIDO} AND c.tipo_comprobante <> '07'
          AND c.fecha_emision >= date_trunc('month', $2::date) AND c.fecha_emision <= $2::date
        GROUP BY 1 ORDER BY 3 DESC LIMIT 5)
     SELECT descripcion, cantidad::text, monto::text AS ventas,
            coalesce(round(monto * 100 / nullif(max(monto) OVER (), 0)), 0)::int AS alto
       FROM v ORDER BY monto DESC`,
    p,
  )).rows;

  return {
    hoy: { ventas: soles(r.hoy), comprobantes: r.hoy_n },
    mes: {
      ventas: ventasMes.toFixed(2),
      comprobantes: r.mes_n,
      ticketPromedio: r.mes_n ? ventasMes.div(r.mes_n).toFixed(2) : '0.00',
      variacion: anterior.isZero() ? null : ventasMes.minus(anterior).div(anterior).times(100).toFixed(1),
    },
    clientes: { mes: cl.mes, nuevos: cl.nuevos },
    meses: meses.map((m) => ({
      periodo: m.periodo, nombre: MES_CORTO[Number(m.periodo.slice(5, 7)) - 1]!, ventas: soles(m.ventas), alto: m.alto,
      ...(opciones.compras ? { compras: soles(m.compras), altoCompras: m.alto_compras } : {}),
    })),
    dias: dias.map((d) => ({ fecha: d.fecha, ventas: soles(d.ventas), alto: d.alto })),
    canales: canales.map((c) => ({ canal: c.canal, ventas: soles(c.ventas), porcentaje: c.porcentaje })),
    productos: productos.map((x) => ({ descripcion: x.descripcion, cantidad: dec(x.cantidad).toString(), ventas: soles(x.ventas), alto: x.alto })),
    ...(opciones.productos ? { stockBajo: (await listarStock(db, empresaId)).filter((s) => s.bajoMinimo).length } : {}),
  };
}
