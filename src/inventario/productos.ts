/**
 * Catálogo de productos (por SKU) y ajustes manuales de stock.
 */
import { dec } from '../dinero.js';
import { enTransaccion, type Db } from '../db/conexion.js';
import { revisarStock, stockDe } from './stock.js';

export interface DatosProducto {
  sku: string;
  nombre: string;
  /** Precio de venta con IGV, como texto. */
  precio: string;
  unidad?: string;
  controlaStock?: boolean;
  stockMinimo?: string;
  marca?: string;
  /** Lo que lee el escáner (EAN, UPC…). Vacío = se quita. */
  codigoBarras?: string;
}

export class ErrorInventario extends Error {}

/** Crea o actualiza un producto por su SKU. El costo promedio solo lo cambian las compras. */
export async function guardarProducto(db: Db, empresaId: string, p: DatosProducto): Promise<string> {
  const sku = p.sku.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(sku)) throw new ErrorInventario('SKU inválido: letras, números, punto, guion o guion bajo (máx. 40).');
  if (!p.nombre.trim()) throw new ErrorInventario('Falta el nombre del producto.');
  const precio = dec(p.precio);
  if (precio.isNegative()) throw new ErrorInventario('El precio no puede ser negativo.');
  const minimo = p.stockMinimo === undefined ? null : dec(p.stockMinimo);
  const barras = p.codigoBarras?.trim() || null;
  if (barras && !/^[A-Za-z0-9._-]{3,40}$/.test(barras)) throw new ErrorInventario('Código de barras inválido: solo letras y números (3 a 40).');
  if (barras) {
    const otro = await db.query(`SELECT sku FROM productos WHERE empresa_id = $1 AND codigo_barras = $2 AND sku <> $3`, [empresaId, barras, sku]);
    if (otro.rows[0]) throw new ErrorInventario(`Ese código de barras ya es del producto ${otro.rows[0].sku}.`);
  }
  let marcaId: string | null = null;
  if (p.marca) {
    const m = await db.query(`SELECT id FROM marcas WHERE empresa_id = $1 AND lower(nombre) = lower($2)`, [empresaId, p.marca]);
    if (!m.rows[0]) throw new ErrorInventario(`No existe la marca "${p.marca}".`);
    marcaId = m.rows[0].id as string;
  }
  const r = await db.query(
    `INSERT INTO productos (empresa_id, sku, nombre, precio_con_igv, unidad_medida, controla_stock, stock_minimo, marca_id, codigo_barras)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (empresa_id, sku) DO UPDATE SET nombre = EXCLUDED.nombre, precio_con_igv = EXCLUDED.precio_con_igv,
       unidad_medida = EXCLUDED.unidad_medida, controla_stock = EXCLUDED.controla_stock, stock_minimo = EXCLUDED.stock_minimo,
       marca_id = coalesce(EXCLUDED.marca_id, productos.marca_id), activo = true,
       -- Sin código en el formulario se conserva el que tenía (no se borra por olvido).
       codigo_barras = CASE WHEN $10 THEN EXCLUDED.codigo_barras ELSE productos.codigo_barras END
     RETURNING id`,
    [empresaId, sku, p.nombre.trim(), precio.toString(), p.unidad ?? 'NIU', p.controlaStock ?? true, minimo?.toString() ?? null, marcaId, barras, p.codigoBarras !== undefined],
  );
  return r.rows[0].id as string;
}

/** Ajuste manual (inventario físico, merma, producto dañado…). Motivo obligatorio. */
export async function ajustarStock(db: Db, empresaId: string, sku: string, cantidad: string, motivo: string, usuarioId?: string): Promise<string> {
  if (!motivo.trim()) throw new ErrorInventario('Indica el motivo del ajuste (ej. "conteo físico", "producto dañado").');
  const c = dec(cantidad);
  if (c.isZero()) throw new ErrorInventario('La cantidad del ajuste no puede ser cero (usa + para entrada, − para salida).');
  return enTransaccion(db, async (tx) => {
    const p = await tx.query(`SELECT id FROM productos WHERE empresa_id = $1 AND sku = $2 FOR UPDATE`, [empresaId, sku.toUpperCase()]);
    const id = p.rows[0]?.id as string | undefined;
    if (!id) throw new ErrorInventario(`No existe el producto ${sku}.`);
    await tx.query(
      `INSERT INTO movimientos_stock (empresa_id, producto_id, tipo, cantidad, motivo, usuario_id) VALUES ($1, $2, 'AJUSTE', $3, $4, $5)`,
      [empresaId, id, c.toString(), motivo.trim(), usuarioId ?? null],
    );
    await revisarStock(tx, empresaId, [id]);
    return (await stockDe(tx, id)).toString();
  });
}

export interface FilaStock {
  sku: string;
  nombre: string;
  stock: string;
  minimo: string | null;
  costoPromedio: string | null;
  bajoMinimo: boolean;
}

export async function listarStock(db: Db, empresaId: string): Promise<FilaStock[]> {
  const r = await db.query(
    `SELECT p.sku, p.nombre, p.stock_minimo, p.costo_promedio, coalesce(sum(m.cantidad), 0)::text AS stock
     FROM productos p LEFT JOIN movimientos_stock m ON m.producto_id = p.id
     WHERE p.empresa_id = $1 AND p.activo AND p.controla_stock
     GROUP BY p.id ORDER BY p.sku`,
    [empresaId],
  );
  return r.rows.map((f) => {
    const stock = dec(f.stock as string);
    return {
      sku: f.sku, nombre: f.nombre, stock: stock.toString(),
      minimo: f.stock_minimo === null ? null : dec(f.stock_minimo as string).toString(),
      costoPromedio: f.costo_promedio === null ? null : dec(f.costo_promedio as string).toFixed(2),
      bajoMinimo: stock.isNegative() || (f.stock_minimo !== null && stock.lte(dec(f.stock_minimo as string))),
    };
  });
}
