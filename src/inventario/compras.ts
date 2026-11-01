/**
 * Registro de facturas de proveedores: suma stock y actualiza el costo promedio.
 *
 * Los montos se copian TAL CUAL de la factura del proveedor (base, IGV, total) y se
 * verifica que cuadren con los ítems, para atrapar errores de digitación.
 * La validación en SUNAT (existencia del comprobante, proveedor habido) es parte del
 * módulo de crédito fiscal: por ahora la compra queda "PENDIENTE" de validar.
 */
import { Decimal, dec, redondear, sumar } from '../dinero.js';
import { codigoErrorPg, enTransaccion, restriccionPg, type Db } from '../db/conexion.js';
import { esRucValido } from '../validaciones/documentos.js';
import { ErrorInventario } from './productos.js';
import { revisarStock, stockDe } from './stock.js';
import { esFecha } from '../fechas.js';

export interface ItemCompra {
  /** SKU del producto (opcional: si no hay, es un gasto/insumo sin stock). */
  sku?: string;
  descripcion: string;
  cantidad: string;
  /** Costo unitario SIN IGV, como texto. */
  costoUnitario: string;
}

export interface DatosCompra {
  proveedor: { ruc: string; razonSocial: string };
  tipoComprobante?: '01' | '03';
  serie: string;
  numero: number;
  fecha: string;
  /** Montos de la factura del proveedor (texto). */
  igv: string;
  total: string;
  otros?: string;
  items: ItemCompra[];
  notas?: string;
  /** Compra al crédito: fecha en que vence el pago al proveedor (sin esto, es al contado). */
  vence?: string;
}

export async function registrarCompra(db: Db, empresaId: string, d: DatosCompra, usuarioId?: string): Promise<{ compraId: string; base: string }> {
  if (!d?.proveedor || !Array.isArray(d.items)) throw new ErrorInventario('Faltan los datos del proveedor o los ítems de la compra.');
  const errores: string[] = [];
  if (!esRucValido(d.proveedor.ruc)) errores.push(`RUC del proveedor inválido: ${d.proveedor.ruc}.`);
  if (!d.proveedor.razonSocial?.trim()) errores.push('Falta la razón social del proveedor.');
  if (!/^[A-Z0-9]{1,4}$/i.test(d.serie) || !Number.isSafeInteger(d.numero) || d.numero < 1) errores.push('Serie o número del comprobante del proveedor inválidos.');
  if (!esFecha(d.fecha)) errores.push('Fecha inválida (AAAA-MM-DD).');
  if (d.items.length === 0) errores.push('La compra debe tener al menos un ítem.');
  if (d.vence !== undefined && (!esFecha(d.vence) || (esFecha(d.fecha) && d.vence < d.fecha))) errores.push('La fecha de vencimiento del crédito debe ser igual o posterior a la de la compra.');
  if (errores.length) throw new ErrorInventario(errores.join(' '));

  const items = d.items.map((it) => {
    const cantidad = dec(it.cantidad);
    const costo = dec(it.costoUnitario);
    if (cantidad.lte(0) || costo.isNegative()) throw new ErrorInventario(`Ítem "${it.descripcion}": cantidad o costo inválidos.`);
    return { ...it, cantidad, costo, total: redondear(cantidad.times(costo)) };
  });
  const base = sumar(items.map((i) => i.total));
  const igv = dec(d.igv);
  const otros = dec(d.otros ?? '0');
  const total = dec(d.total);
  if (!base.plus(igv).plus(otros).eq(total)) {
    throw new ErrorInventario(
      `Los montos no cuadran: ítems S/ ${base.toFixed(2)} + IGV S/ ${igv.toFixed(2)}${otros.isZero() ? '' : ` + otros S/ ${otros.toFixed(2)}`} ≠ total S/ ${total.toFixed(2)}. Revisa lo digitado.`,
    );
  }

  try {
    return await enTransaccion(db, async (tx) => {
      const prov = await tx.query(
        `INSERT INTO proveedores (empresa_id, ruc, razon_social) VALUES ($1, $2, $3)
         ON CONFLICT (empresa_id, ruc) DO UPDATE SET razon_social = EXCLUDED.razon_social RETURNING id`,
        [empresaId, d.proveedor.ruc, d.proveedor.razonSocial.trim()],
      );
      const c = await tx.query(
        `INSERT INTO compras (empresa_id, proveedor_id, tipo_comprobante, serie, numero, fecha_emision, periodo, base_imponible, igv, otros, total, notas, registrado_por, condicion, vence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [empresaId, prov.rows[0].id, d.tipoComprobante ?? '01', d.serie.toUpperCase(), d.numero, d.fecha, d.fecha.slice(0, 7),
          base.toFixed(2), igv.toFixed(2), otros.toFixed(2), total.toFixed(2), d.notas ?? null, usuarioId ?? null, d.vence ? 'CREDITO' : 'CONTADO', d.vence ?? null],
      );
      const compraId = c.rows[0].id as string;
      const afectados: string[] = [];
      for (const [i, it] of items.entries()) {
        let productoId: string | null = null;
        if (it.sku) {
          // Bloquea el producto: el costo promedio se calcula con el stock de ese momento.
          const p = await tx.query(
            `SELECT id, controla_stock, costo_promedio FROM productos WHERE empresa_id = $1 AND sku = $2 FOR UPDATE`,
            [empresaId, it.sku.toUpperCase()],
          );
          const prod = p.rows[0];
          if (!prod) throw new ErrorInventario(`No existe el producto ${it.sku}. Créalo primero.`);
          productoId = prod.id as string;
          if (prod.controla_stock) {
            const stock = Decimal.max(await stockDe(tx, productoId), 0);
            const costoAnterior = prod.costo_promedio === null ? it.costo : dec(prod.costo_promedio as string);
            // Promedio ponderado: (stock × costo anterior + cantidad × costo nuevo) / (stock + cantidad)
            const promedio = redondear(stock.times(costoAnterior).plus(it.cantidad.times(it.costo)).div(stock.plus(it.cantidad)), 10);
            await tx.query(`UPDATE productos SET costo_promedio = $2 WHERE id = $1`, [productoId, promedio.toString()]);
            await tx.query(
              `INSERT INTO movimientos_stock (empresa_id, producto_id, tipo, cantidad, costo_unitario, compra_id, usuario_id) VALUES ($1, $2, 'COMPRA', $3, $4, $5, $6)`,
              [empresaId, productoId, it.cantidad.toString(), it.costo.toString(), compraId, usuarioId ?? null],
            );
            afectados.push(productoId);
          } else {
            // Sin control de stock: igual se guarda el último costo para calcular el margen.
            await tx.query(`UPDATE productos SET costo_promedio = $2 WHERE id = $1`, [productoId, it.costo.toString()]);
          }
        }
        await tx.query(
          `INSERT INTO compra_items (compra_id, orden, producto_id, descripcion, cantidad, costo_unitario, total) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [compraId, i + 1, productoId, it.descripcion, it.cantidad.toString(), it.costo.toString(), it.total.toFixed(2)],
        );
      }
      await revisarStock(tx, empresaId, afectados);
      await tx.query(
        `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'REGISTRAR_COMPRA', 'compras', $3, $4)`,
        [empresaId, usuarioId ?? null, compraId, JSON.stringify({ proveedor: d.proveedor.ruc, comprobante: `${d.serie}-${d.numero}`, total: total.toFixed(2) })],
      );
      return { compraId, base: base.toFixed(2) };
    });
  } catch (e) {
    if (codigoErrorPg(e) === '23505' && restriccionPg(e)?.startsWith('compras_')) {
      throw new ErrorInventario(`La factura ${d.serie}-${d.numero} del proveedor ${d.proveedor.ruc} ya estaba registrada.`);
    }
    throw e;
  }
}
