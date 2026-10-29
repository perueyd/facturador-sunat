/**
 * Venta rápida: lo que más se vendió en los últimos 60 días, para venderlo de nuevo con un
 * toque (un corte, una barba…). Sale de los comprobantes, así que funciona aunque el negocio
 * no use el catálogo de productos.
 */
import type { Db } from '../db/conexion.js';

export interface ProductoRapido {
  /** Código del producto (si se vendió con uno): así la venta descuenta stock. */
  codigo: string | null;
  descripcion: string;
  precio: string;
}

export async function masVendidos(db: Db, empresaId: string, hoy: string, limite = 8): Promise<ProductoRapido[]> {
  const r = await db.query(
    `SELECT i.codigo, i.descripcion, i.precio_unitario_con_igv::numeric(14,2)::text AS precio
       FROM comprobante_items i JOIN comprobantes c ON c.id = i.comprobante_id
      WHERE c.empresa_id = $1 AND c.tipo_comprobante IN ('01', '03') AND c.estado NOT IN ('RECHAZADO', 'ANULADO')
        AND c.fecha_emision > $2::date - 60
      GROUP BY 1, 2, 3 ORDER BY count(*) DESC, 2 LIMIT $3`,
    [empresaId, hoy, limite],
  );
  return r.rows.map((f) => ({ codigo: f.codigo, descripcion: f.descripcion, precio: f.precio }));
}
