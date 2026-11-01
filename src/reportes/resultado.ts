/**
 * Resultado del mes (ESTIMADO): cuánto quedó del negocio.
 *
 *   resultado = ventas sin IGV − compras sin IGV − gastos
 *
 * Ventas: boletas y facturas aceptadas o en camino, menos notas de crédito. Compras: base
 * imponible de las compras del período (su IGV se recupera aparte). Gastos: lo registrado en
 * caja chica, tal cual se pagó. Es una guía para el dueño, NO el resultado contable: no
 * considera stock que quedó sin vender, depreciación ni impuestos; eso lo calcula el contador.
 */
import type { Db } from '../db/conexion.js';
import { dec } from '../dinero.js';

export interface ResultadoMes {
  mes: string;
  ventas: string;
  compras: string;
  gastos: string;
  resultado: string;
  /** Resultado sobre las ventas, en % (null si no hubo ventas). */
  margen: string | null;
  estimado: true;
}

export async function resultadoDelMes(db: Db, empresaId: string, mes: string, opciones: { compras: boolean; gastos: boolean }): Promise<ResultadoMes> {
  const r = (await db.query(
    `SELECT (SELECT coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -1 ELSE 1 END * (total_gravado + total_exonerado + total_inafecto)), 0)
               FROM comprobantes WHERE empresa_id = $1 AND to_char(fecha_emision, 'YYYY-MM') = $2 AND estado NOT IN ('RECHAZADO', 'ANULADO'))::text AS ventas,
            (SELECT coalesce(sum(base_imponible + otros), 0) FROM compras WHERE empresa_id = $1 AND periodo = $2 AND anulada_en IS NULL)::text AS compras,
            (SELECT coalesce(sum(monto), 0) FROM gastos WHERE empresa_id = $1 AND to_char(fecha, 'YYYY-MM') = $2 AND anulado_en IS NULL)::text AS gastos`,
    [empresaId, mes],
  )).rows[0];
  const ventas = dec(r.ventas);
  const compras = opciones.compras ? dec(r.compras) : dec('0');
  const gastos = opciones.gastos ? dec(r.gastos) : dec('0');
  const resultado = ventas.minus(compras).minus(gastos);
  return {
    mes, ventas: ventas.toFixed(2), compras: compras.toFixed(2), gastos: gastos.toFixed(2), resultado: resultado.toFixed(2),
    margen: ventas.gt(0) ? resultado.div(ventas).times(100).toFixed(1) : null, estimado: true,
  };
}
