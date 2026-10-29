/**
 * Margen semanal (lunes a domingo, hora de Lima), estimado:
 *   ventas sin IGV − costo de lo vendido (cantidad × costo promedio guardado al emitir).
 * Las notas de crédito restan venta; si son por devolución (motivos 06/07) también restan
 * costo, porque el producto volvió. Los ítems sin costo conocido (sin SKU o sin compras
 * registradas) se informan aparte y NO entran al margen, para no inflarlo.
 * Uso interno (CLI): los costos no se exponen por la API de la tienda.
 */
import { Decimal, dec, redondear } from '../dinero.js';
import type { Db } from '../db/conexion.js';
import { ahoraLima, esFecha } from '../fechas.js';
import { ErrorInventario } from '../inventario/productos.js';

const MOTIVOS_DEVOLUCION = new Set(['06', '07']);

export interface MargenSemanal {
  desde: string;
  hasta: string;
  /** Ventas netas sin IGV (menos notas de crédito). */
  ventas: string;
  costo: string;
  margen: string;
  /** Margen sobre las ventas con costo conocido, en %. */
  porcentaje: string | null;
  sinCosto: { items: number; ventas: string };
  meta: { monto: string; cumplimiento: string } | null;
}

/** Lunes de la semana de `fecha` (AAAA-MM-DD). */
function lunesDe(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export async function margenSemanal(db: Db, empresaId: string, fecha = ahoraLima().fecha): Promise<MargenSemanal> {
  const desde = lunesDe(fecha);
  const hasta = sumarDias(desde, 6);
  const r = await db.query(
    `SELECT c.tipo_comprobante AS tipo, c.motivo_nota_codigo AS motivo, i.valor_venta, i.cantidad::text, i.costo_unitario::text
     FROM comprobante_items i JOIN comprobantes c ON c.id = i.comprobante_id
     WHERE c.empresa_id = $1 AND c.fecha_emision BETWEEN $2 AND $3 AND c.estado NOT IN ('RECHAZADO', 'ANULADO')`,
    [empresaId, desde, hasta],
  );
  let ventas = new Decimal(0);
  let ventasSinCosto = new Decimal(0);
  let costo = new Decimal(0);
  let itemsSinCosto = 0;
  for (const f of r.rows) {
    const esNota = f.tipo === '07';
    const signo = esNota ? -1 : 1;
    const valor = dec(f.valor_venta as string).times(signo);
    ventas = ventas.plus(valor);
    if (esNota && !MOTIVOS_DEVOLUCION.has(f.motivo)) continue; // descuento o corrección: solo resta venta
    if (f.costo_unitario === null) {
      ventasSinCosto = ventasSinCosto.plus(valor);
      if (!esNota) itemsSinCosto++;
    } else {
      costo = costo.plus(dec(f.cantidad as string).times(dec(f.costo_unitario as string)).times(signo));
    }
  }
  // Los descuentos globales (cupones, ofertas) rebajan la venta sin tocar los ítems.
  const d = await db.query(
    `SELECT coalesce(sum(descuento_global), 0)::text AS total FROM comprobantes
     WHERE empresa_id = $1 AND fecha_emision BETWEEN $2 AND $3 AND estado NOT IN ('RECHAZADO', 'ANULADO')`,
    [empresaId, desde, hasta],
  );
  ventas = ventas.minus(dec(d.rows[0].total as string));
  costo = redondear(costo);
  const conCosto = ventas.minus(ventasSinCosto);
  const margen = conCosto.minus(costo);

  const m = await db.query(
    `SELECT monto::text FROM metas WHERE empresa_id = $1 AND tipo = 'MARGEN_SEMANAL' AND vigente_desde <= $2
     ORDER BY vigente_desde DESC LIMIT 1`,
    [empresaId, desde],
  );
  const meta = m.rows[0] ? dec(m.rows[0].monto as string) : undefined;
  return {
    desde, hasta,
    ventas: ventas.toFixed(2), costo: costo.toFixed(2), margen: margen.toFixed(2),
    porcentaje: conCosto.isZero() ? null : redondear(margen.div(conCosto).times(100), 1).toFixed(1),
    sinCosto: { items: itemsSinCosto, ventas: ventasSinCosto.toFixed(2) },
    meta: meta ? { monto: meta.toFixed(2), cumplimiento: redondear(margen.div(meta).times(100), 1).toFixed(1) } : null,
  };
}

/** Fija la meta de margen semanal desde una fecha (las semanas anteriores conservan su meta). */
export async function fijarMetaMargen(db: Db, empresaId: string, monto: string, desde = ahoraLima().fecha): Promise<void> {
  const valor = dec(monto);
  if (valor.lte(0)) throw new ErrorInventario('La meta debe ser mayor que cero.');
  if (!esFecha(desde)) throw new ErrorInventario('Fecha inválida (AAAA-MM-DD).');
  await db.query(
    `INSERT INTO metas (empresa_id, tipo, monto, vigente_desde) VALUES ($1, 'MARGEN_SEMANAL', $2, $3)
     ON CONFLICT (empresa_id, tipo, vigente_desde) DO UPDATE SET monto = EXCLUDED.monto`,
    [empresaId, valor.toFixed(2), lunesDe(desde)],
  );
}
