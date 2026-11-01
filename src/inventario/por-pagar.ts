/**
 * Cuentas por pagar: lo que se debe a cada proveedor por compras al crédito.
 *
 * Saldo = total de la compra − pagos no anulados. Cada pago dice de qué cuenta salió el
 * dinero, así la caja y el cierre lo restan. Avisa lo vencido y lo que vence en 7 días.
 * Montos exactos (NUMERIC); un pago no se cambia ni se borra: se anula con motivo.
 */
import { enTransaccion, type Db } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { diasEntre, esFecha } from '../fechas.js';
import { MEDIOS_PAGO, type MedioPago } from '../cobros/pagos.js';

export class ErrorPorPagar extends Error {}

/** Días antes del vencimiento en que una deuda pasa a "vence pronto". */
const DIAS_AVISO = 7;

export type EstadoDeuda = 'VENCIDA' | 'VENCE_PRONTO' | 'AL_DIA';

export interface Deuda {
  compraId: string;
  proveedor: string;
  ruc: string;
  documento: string;
  fecha: string;
  vence: string;
  diasParaVencer: number;
  total: string;
  pagado: string;
  saldo: string;
  estado: EstadoDeuda;
  pagos: { id: string; fecha: string; monto: string; medio: string; cuenta: string | null; anulado: string | null }[];
}

export async function porPagar(db: Db, empresaId: string, hoy: string): Promise<{ deudas: Deuda[]; resumen: { total: string; vencido: string; vencePronto: string; proveedores: number } }> {
  const r = await db.query(
    `SELECT c.id, p.razon_social, p.ruc, c.serie || '-' || c.numero AS documento, c.fecha_emision::text AS fecha, c.vence::text AS vence, c.total::text AS total,
            coalesce((SELECT sum(monto) FROM pagos_compra WHERE compra_id = c.id AND anulado_en IS NULL), 0)::text AS pagado,
            coalesce((SELECT json_agg(json_build_object('id', g.id, 'fecha', g.fecha::text, 'monto', g.monto::text, 'medio', g.medio::text,
                        'cuenta', k.nombre, 'anulado', g.motivo_anulacion) ORDER BY g.fecha, g.creado_en)
                        FROM pagos_compra g LEFT JOIN cuentas_cobro k ON k.id = g.cuenta_id WHERE g.compra_id = c.id), '[]') AS pagos
       FROM compras c JOIN proveedores p ON p.id = c.proveedor_id
      WHERE c.empresa_id = $1 AND c.condicion = 'CREDITO' AND c.anulada_en IS NULL
      ORDER BY c.vence, c.fecha_emision`,
    [empresaId],
  );
  let total = dec('0');
  let vencido = dec('0');
  let pronto = dec('0');
  const proveedores = new Set<string>();
  const deudas = r.rows.flatMap((f): Deuda[] => {
    const saldo = dec(f.total).minus(dec(f.pagado));
    if (!saldo.gt(0)) return [];
    const dias = diasEntre(hoy, f.vence);
    const estado: EstadoDeuda = dias < 0 ? 'VENCIDA' : dias <= DIAS_AVISO ? 'VENCE_PRONTO' : 'AL_DIA';
    total = total.plus(saldo);
    if (estado === 'VENCIDA') vencido = vencido.plus(saldo);
    if (estado === 'VENCE_PRONTO') pronto = pronto.plus(saldo);
    proveedores.add(f.ruc);
    return [{
      compraId: f.id, proveedor: f.razon_social, ruc: f.ruc, documento: f.documento, fecha: f.fecha, vence: f.vence, diasParaVencer: dias,
      total: dec(f.total).toFixed(2), pagado: dec(f.pagado).toFixed(2), saldo: saldo.toFixed(2), estado,
      pagos: (f.pagos as Deuda['pagos']).map((g) => ({ ...g, monto: dec(g.monto).toFixed(2) })),
    }];
  });
  return { deudas, resumen: { total: total.toFixed(2), vencido: vencido.toFixed(2), vencePronto: pronto.toFixed(2), proveedores: proveedores.size } };
}

/** Pago (total o parcial) a un proveedor. Sin monto, paga todo el saldo. */
export async function pagarCompra(
  db: Db,
  empresaId: string,
  compraId: string,
  p: { monto?: string; medio: string; cuentaId?: string; fecha: string; referencia?: string },
  usuarioId: string,
  hoy: string,
): Promise<{ id: string; saldo: string }> {
  if (!esFecha(p.fecha) || p.fecha > hoy) throw new ErrorPorPagar('La fecha del pago debe ser de hoy hacia atrás.');
  if (!MEDIOS_PAGO.includes(p.medio as MedioPago)) throw new ErrorPorPagar('Elige de dónde salió el dinero.');
  if (p.monto !== undefined && (!/^\d{1,11}(\.\d{1,2})?$/.test(p.monto) || !dec(p.monto).gt(0))) throw new ErrorPorPagar('Monto inválido, por ejemplo 350.00.');
  return enTransaccion(db, async (tx) => {
    // Se bloquea la compra: dos pagos a la vez no pueden pasarse del saldo.
    const c = (await tx.query(
      `SELECT total::text AS total, condicion, anulada_en FROM compras WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
      [compraId, empresaId],
    )).rows[0];
    if (!c || c.anulada_en) throw new ErrorPorPagar('Compra no encontrada.');
    if (c.condicion !== 'CREDITO') throw new ErrorPorPagar('Esa compra fue al contado: no tiene saldo por pagar.');
    if (p.cuentaId) {
      const k = (await tx.query(`SELECT medio::text AS medio FROM cuentas_cobro WHERE id = $1 AND empresa_id = $2 AND activa`, [p.cuentaId, empresaId])).rows[0];
      if (!k) throw new ErrorPorPagar('Esa cuenta no existe o está desactivada.');
      if (k.medio !== p.medio) throw new ErrorPorPagar(`Esa cuenta es de ${k.medio}, no de ${p.medio}.`);
    }
    const pagado = dec((await tx.query(`SELECT coalesce(sum(monto), 0)::text AS s FROM pagos_compra WHERE compra_id = $1 AND anulado_en IS NULL`, [compraId])).rows[0].s);
    const saldo = dec(c.total).minus(pagado);
    if (!saldo.gt(0)) throw new ErrorPorPagar('Esa compra ya está pagada.');
    const monto = p.monto === undefined ? saldo : dec(p.monto);
    if (monto.gt(saldo)) throw new ErrorPorPagar(`El pago (S/ ${monto.toFixed(2)}) supera el saldo (S/ ${saldo.toFixed(2)}).`);
    const id = (await tx.query(
      `INSERT INTO pagos_compra (empresa_id, compra_id, fecha, monto, medio, cuenta_id, referencia, registrado_por) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [empresaId, compraId, p.fecha, monto.toFixed(2), p.medio, p.cuentaId ?? null, p.referencia?.trim().slice(0, 60) || null, usuarioId],
    )).rows[0].id as string;
    return { id, saldo: saldo.minus(monto).toFixed(2) };
  });
}

export async function anularPagoCompra(db: Db, empresaId: string, pagoId: string, motivo: string, usuarioId: string): Promise<boolean> {
  const m = motivo.trim();
  if (m.length < 3) throw new ErrorPorPagar('Escribe por qué se anula el pago.');
  const r = await db.query(
    `UPDATE pagos_compra SET anulado_en = now(), anulado_por = $3, motivo_anulacion = $4 WHERE id = $1 AND empresa_id = $2 AND anulado_en IS NULL RETURNING id`,
    [pagoId, empresaId, usuarioId, m.slice(0, 200)],
  );
  if (r.rowCount) {
    await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, motivo) VALUES ($1, $2, 'ANULAR_PAGO_COMPRA', 'pagos_compra', $3, $4)`, [empresaId, usuarioId, pagoId, m]);
  }
  return Boolean(r.rowCount);
}
