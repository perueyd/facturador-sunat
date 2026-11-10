/**
 * Resumen del día: ventas, cobros por medio de pago, saldos por cobrar y
 * pendientes con SUNAT. Todo lo de ventas excluye rechazados y anulados.
 */
import { SQL_SE_COBRA, sqlSaldo } from '../cobros/pagos.js';
import { dec, sumar } from '../dinero.js';
import type { Db } from '../db/conexion.js';
import { ahoraLima } from '../fechas.js';

export interface ResumenDia {
  fecha: string;
  ventas: { cantidad: number; total: string; porTipo: Record<string, { cantidad: number; total: string }> };
  notasCredito: { cantidad: number; total: string };
  cobros: { total: string; porMedio: Record<string, string> };
  porCobrar: { comprobantes: number; saldo: string; cuotasVencidas: number };
  sunat: { pendientes: number; rechazadosHoy: number; porRevisar: number };
  alertasAbiertas: number;
}

const NOMBRES: Record<string, string> = { '01': 'FACTURA', '03': 'BOLETA', '08': 'NOTA_DEBITO' };

export async function resumenDelDia(db: Db, empresaId: string, fecha = ahoraLima().fecha): Promise<ResumenDia> {
  const ventas = await db.query(
    `SELECT tipo_comprobante AS tipo, count(*)::int AS cantidad, coalesce(sum(importe_total), 0)::text AS total
     FROM comprobantes WHERE empresa_id = $1 AND fecha_emision = $2 AND estado NOT IN ('RECHAZADO', 'ANULADO')
     GROUP BY tipo_comprobante`,
    [empresaId, fecha],
  );
  const cobros = await db.query(
    `SELECT medio::text, sum(monto)::text AS total FROM pagos
     WHERE empresa_id = $1 AND fecha = $2 AND anulado_en IS NULL GROUP BY medio ORDER BY medio`,
    [empresaId, fecha],
  );
  const porCobrar = await db.query(
    `SELECT count(*)::int AS comprobantes,
            coalesce(sum(${sqlSaldo('c')}), 0)::text AS saldo,
            (SELECT count(*)::int FROM comprobante_cuotas q JOIN comprobantes cc ON cc.id = q.comprobante_id
             WHERE cc.empresa_id = $1 AND NOT q.pagada AND q.fecha_vencimiento < $2::date AND cc.estado NOT IN ('RECHAZADO','ANULADO')) AS cuotas_vencidas
     FROM comprobantes c
     WHERE c.empresa_id = $1 AND c.tipo_comprobante ${SQL_SE_COBRA} AND c.estado_pago <> 'PAGADO' AND c.estado NOT IN ('RECHAZADO', 'ANULADO')`,
    [empresaId, fecha],
  );
  const sunat = await db.query(
    `SELECT count(*) FILTER (WHERE estado IN ('EMITIDO_LOCAL', 'PENDIENTE_ENVIO'))::int AS pendientes,
            count(*) FILTER (WHERE estado = 'RECHAZADO' AND fecha_emision = $2)::int AS rechazados,
            (SELECT count(*)::int FROM cola_envios WHERE empresa_id = $1 AND estado = 'FALLIDO_REVISAR') AS revisar,
            (SELECT count(*)::int FROM alertas WHERE empresa_id = $1 AND resuelta_en IS NULL) AS alertas
     FROM comprobantes WHERE empresa_id = $1`,
    [empresaId, fecha],
  );

  const porTipo: ResumenDia['ventas']['porTipo'] = {};
  let notas = { cantidad: 0, total: '0.00' };
  const totalesVenta = [];
  for (const f of ventas.rows) {
    if (f.tipo === '07') {
      notas = { cantidad: f.cantidad, total: dec(f.total).toFixed(2) };
      continue;
    }
    porTipo[NOMBRES[f.tipo] ?? f.tipo] = { cantidad: f.cantidad, total: dec(f.total).toFixed(2) };
    totalesVenta.push(f);
  }
  const s = sunat.rows[0];
  const p = porCobrar.rows[0];
  return {
    fecha,
    ventas: {
      cantidad: totalesVenta.reduce((a, f) => a + (f.cantidad as number), 0),
      total: sumar(totalesVenta.map((f) => dec(f.total))).toFixed(2),
      porTipo,
    },
    notasCredito: notas,
    cobros: {
      total: sumar(cobros.rows.map((f) => dec(f.total))).toFixed(2),
      porMedio: Object.fromEntries(cobros.rows.map((f) => [f.medio, dec(f.total).toFixed(2)])),
    },
    porCobrar: { comprobantes: p.comprobantes, saldo: dec(p.saldo).toFixed(2), cuotasVencidas: p.cuotas_vencidas },
    sunat: { pendientes: s.pendientes, rechazadosHoy: s.rechazados, porRevisar: s.revisar },
    alertasAbiertas: s.alertas,
  };
}
