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

/**
 * Lo que se vendió en el último año (descripción y su ÚLTIMO precio), para sugerirlo al
 * escribir en Vender aunque no esté guardado como producto. Así la lista "aprende" sola.
 * No repite lo que ya es un producto guardado (ese ya sale con su precio de catálogo).
 *
 * Mira como mucho las últimas VENTAS_REVISADAS ventas: esta consulta corre cada vez que se abre
 * el panel, y con una empresa de 60.000 comprobantes al año recorría el año entero (0,23 s).
 * Un negocio chico no llega a ese tope en un año; uno grande aprende de sus ventas más recientes.
 */
const VENTAS_REVISADAS = 3000;

export async function vendidosAntes(db: Db, empresaId: string, hoy: string, limite = 300): Promise<ProductoRapido[]> {
  const r = await db.query(
    // Primero una fila por descripción (la venta más reciente) y DESPUÉS se descarta lo que ya es
    // producto: así se compara contra el catálogo unas cientos de veces, no una vez por cada
    // línea vendida en el año (con miles de ventas, eso era lento).
    `WITH recientes AS (
       SELECT id, fecha_emision, creado_en FROM comprobantes
        WHERE empresa_id = $1 AND tipo_comprobante IN ('01', '03') AND estado NOT IN ('RECHAZADO', 'ANULADO')
          AND fecha_emision > $2::date - 365
        ORDER BY fecha_emision DESC LIMIT ${VENTAS_REVISADAS}),
     ultimas AS (
       SELECT DISTINCT ON (lower(i.descripcion)) i.codigo, i.descripcion, i.precio_unitario_con_igv::numeric(14,2)::text AS precio, c.fecha_emision
         FROM comprobante_items i JOIN recientes c ON c.id = i.comprobante_id
        ORDER BY lower(i.descripcion), c.fecha_emision DESC, c.creado_en DESC)
     SELECT u.codigo, u.descripcion, u.precio FROM ultimas u
      WHERE NOT EXISTS (SELECT 1 FROM productos p WHERE p.empresa_id = $1 AND p.activo AND (p.sku = u.codigo OR lower(p.nombre) = lower(u.descripcion)))
      ORDER BY u.fecha_emision DESC LIMIT $3`,
    [empresaId, hoy, limite],
  );
  return r.rows.map((f) => ({ codigo: f.codigo, descripcion: f.descripcion, precio: f.precio }));
}
