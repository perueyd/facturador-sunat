/**
 * Cobros: registrar pagos, saldo de cada comprobante y estado de pago.
 *
 * Saldo = importe total − pagos vigentes − notas de crédito vigentes que lo modifican.
 * Estado: PENDIENTE (nada cobrado), PARCIAL o PAGADO. Las cuotas se cubren en orden
 * de vencimiento.
 */
import { crearAlerta } from '../alertas.js';
import { Decimal, dec } from '../dinero.js';
import { codigoErrorPg, enTransaccion, restriccionPg, type Db, type Tx } from '../db/conexion.js';
import { ahoraLima } from '../fechas.js';
import { idComprobanteLegible } from '../tipos.js';

export const MEDIOS_PAGO = ['YAPE', 'PLIN', 'EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'PASARELA', 'OTRO'] as const;
export type MedioPago = (typeof MEDIOS_PAGO)[number];

export interface NuevoPago {
  empresaId: string;
  comprobanteId: string;
  /** Monto como texto ("350.00"). Si se omite, se cobra el saldo completo. */
  monto?: string;
  medio: MedioPago;
  /** Cuenta donde entró el dinero. Sin ella, se usa la predeterminada de ese medio (si hay). */
  cuentaId?: string;
  /** Número de operación (Yape/Plin/transferencia). Evita registrar dos veces el mismo pago. */
  referencia?: string;
  fecha?: string;
  notas?: string;
  usuarioId?: string;
  apiLlaveId?: string;
}

export interface EstadoCobro {
  total: Decimal;
  pagado: Decimal;
  notasCredito: Decimal;
  saldo: Decimal;
  estadoPago: 'PENDIENTE' | 'PARCIAL' | 'PAGADO';
}

export type ResultadoPago =
  | { resultado: 'REGISTRADO' | 'REPETIDO'; pagoId: string; cobro: EstadoCobro }
  | { resultado: 'ERROR'; errores: string[] };

class ErrorCobro extends Error {}

const NO_COBRABLE = ['RECHAZADO', 'ANULADO', 'ANULACION_EN_PROCESO'];

/** Saldo y estado de pago de un comprobante (solo lectura). */
/** Expresión SQL del saldo pendiente de un comprobante (alias `c`): total − pagos − notas de crédito. */
export function sqlSaldo(c: string): string {
  return `greatest(${c}.importe_total
    - coalesce((SELECT sum(monto) FROM pagos p WHERE p.comprobante_id = ${c}.id AND p.anulado_en IS NULL), 0)
    - coalesce((SELECT sum(nc.importe_total) FROM comprobantes nc WHERE nc.comprobante_referencia_id = ${c}.id AND nc.estado NOT IN ('RECHAZADO', 'ANULADO')), 0), 0)`;
}

export async function estadoCobro(q: Db | Tx, comprobanteId: string): Promise<EstadoCobro> {
  const r = await q.query(
    `SELECT c.importe_total,
            coalesce((SELECT sum(monto) FROM pagos WHERE comprobante_id = c.id AND anulado_en IS NULL), 0) AS pagado,
            coalesce((SELECT sum(importe_total) FROM comprobantes nc
                      WHERE nc.comprobante_referencia_id = c.id AND nc.estado NOT IN ('RECHAZADO', 'ANULADO')), 0) AS notas
     FROM comprobantes c WHERE c.id = $1`,
    [comprobanteId],
  );
  const f = r.rows[0];
  const total = dec(f.importe_total as string);
  const pagado = dec(f.pagado as string);
  const notasCredito = dec(f.notas as string);
  const saldo = Decimal.max(total.minus(pagado).minus(notasCredito), 0);
  const estadoPago = saldo.isZero() ? 'PAGADO' : pagado.isZero() ? 'PENDIENTE' : 'PARCIAL';
  return { total, pagado, notasCredito, saldo, estadoPago };
}

/** Recalcula el saldo y deja al día el estado de pago y las cuotas (dentro de la transacción). */
export async function recalcularCobro(tx: Tx, comprobanteId: string): Promise<EstadoCobro> {
  const cobro = await estadoCobro(tx, comprobanteId);
  const { pagado, notasCredito, estadoPago } = cobro;
  await tx.query(`UPDATE comprobantes SET estado_pago = $2 WHERE id = $1`, [comprobanteId, estadoPago]);

  // Reparte lo cobrado (y las notas de crédito) entre las cuotas en orden de vencimiento.
  let disponible = pagado.plus(notasCredito);
  const cuotas = await tx.query(`SELECT id, monto FROM comprobante_cuotas WHERE comprobante_id = $1 ORDER BY fecha_vencimiento, numero_cuota`, [comprobanteId]);
  for (const q of cuotas.rows) {
    const monto = dec(q.monto as string);
    const cubierto = Decimal.min(monto, disponible);
    disponible = disponible.minus(cubierto);
    await tx.query(`UPDATE comprobante_cuotas SET monto_pagado = $2, pagada = $3 WHERE id = $1`, [q.id, cubierto.toFixed(2), cubierto.eq(monto)]);
  }
  return cobro;
}

export async function registrarPago(db: Db, p: NuevoPago): Promise<ResultadoPago> {
  if (!MEDIOS_PAGO.includes(p.medio)) return { resultado: 'ERROR', errores: [`Medio de pago inválido. Usa: ${MEDIOS_PAGO.join(', ')}.`] };
  const referencia = p.referencia?.trim() || undefined;
  try {
    return await enTransaccion(db, async (tx) => {
      // Bloquea el comprobante: dos pagos simultáneos no pueden pasarse del saldo.
      const r = await tx.query(`SELECT serie, numero, estado, tipo_comprobante FROM comprobantes WHERE id = $1 AND empresa_id = $2 FOR UPDATE`, [p.comprobanteId, p.empresaId]);
      const c = r.rows[0];
      if (!c) throw new ErrorCobro('El comprobante no existe.');
      const nombre = idComprobanteLegible(c.serie, Number(c.numero));

      if (referencia) {
        const ya = await tx.query(
          `SELECT id, comprobante_id FROM pagos WHERE empresa_id = $1 AND medio = $2 AND referencia_operacion = $3 AND anulado_en IS NULL`,
          [p.empresaId, p.medio, referencia],
        );
        if (ya.rows[0]) {
          if (ya.rows[0].comprobante_id !== p.comprobanteId) {
            throw new ErrorCobro(`La operación ${p.medio} ${referencia} ya está registrada como pago de otro comprobante.`);
          }
          return { resultado: 'REPETIDO' as const, pagoId: ya.rows[0].id as string, cobro: await recalcularCobro(tx, p.comprobanteId) };
        }
      }
      if (c.tipo_comprobante === '07') throw new ErrorCobro('Una nota de crédito no se cobra: reduce el saldo del comprobante que modifica.');
      if (NO_COBRABLE.includes(c.estado)) throw new ErrorCobro(`${nombre} está ${c.estado.toLowerCase().replaceAll('_', ' ')}; no se le registran pagos.`);

      const antes = await recalcularCobro(tx, p.comprobanteId);
      if (antes.saldo.isZero()) throw new ErrorCobro(`${nombre} ya está pagado.`);
      // Dónde entró el dinero: la cuenta elegida (manda su medio) o la predeterminada del medio.
      const cuenta = p.cuentaId
        ? (await tx.query(`SELECT id, medio::text FROM cuentas_cobro WHERE id = $1 AND empresa_id = $2 AND activa`, [p.cuentaId, p.empresaId])).rows[0]
        : (await tx.query(`SELECT id, medio::text FROM cuentas_cobro WHERE empresa_id = $1 AND medio = $2 AND predeterminada AND activa`, [p.empresaId, p.medio])).rows[0];
      if (p.cuentaId && !cuenta) throw new ErrorCobro('Esa cuenta no existe o está desactivada.');
      // El medio de la cuenta manda (el nº de operación se busca por medio para no registrarlo dos veces).
      if (cuenta && cuenta.medio !== p.medio) throw new ErrorCobro(`Esa cuenta recibe ${cuenta.medio}, no ${p.medio}.`);
      const medio = p.medio;
      let monto: Decimal;
      try {
        monto = p.monto === undefined ? antes.saldo : dec(p.monto);
      } catch {
        throw new ErrorCobro('Monto inválido: usa texto con punto decimal, por ejemplo "350.00".');
      }
      if (monto.lte(0) || monto.decimalPlaces() > 2) throw new ErrorCobro('El monto debe ser mayor que cero y con máximo 2 decimales.');
      if (monto.gt(antes.saldo)) throw new ErrorCobro(`El pago (S/ ${monto.toFixed(2)}) supera el saldo de ${nombre} (S/ ${antes.saldo.toFixed(2)}).`);
      const fecha = p.fecha ?? ahoraLima().fecha;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha > ahoraLima().fecha) throw new ErrorCobro('La fecha del pago debe ser AAAA-MM-DD y no futura.');

      const ins = await tx.query(
        `INSERT INTO pagos (empresa_id, comprobante_id, fecha, monto, medio, referencia_operacion, notas, registrado_por, api_llave_id, cuenta_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.empresaId, p.comprobanteId, fecha, monto.toFixed(2), medio, referencia ?? null, p.notas ?? null, p.usuarioId ?? null, p.apiLlaveId ?? null, cuenta?.id ?? null],
      );
      const pagoId = ins.rows[0].id as string;
      const cobro = await recalcularCobro(tx, p.comprobanteId);
      await tx.query(
        `INSERT INTO auditoria (empresa_id, usuario_id, api_llave_id, accion, entidad, entidad_id, despues)
         VALUES ($1, $2, $3, 'REGISTRAR_PAGO', 'pagos', $4, $5)`,
        [p.empresaId, p.usuarioId ?? null, p.apiLlaveId ?? null, pagoId,
          JSON.stringify({ comprobante: nombre, monto: monto.toFixed(2), medio, cuenta: cuenta?.id ?? null, referencia: referencia ?? null, estadoPago: cobro.estadoPago })],
      );
      return { resultado: 'REGISTRADO' as const, pagoId, cobro };
    });
  } catch (e) {
    if (e instanceof ErrorCobro) return { resultado: 'ERROR', errores: [e.message] };
    // Dos registros simultáneos de la misma operación: el segundo choca con el índice único.
    if (codigoErrorPg(e) === '23505' && restriccionPg(e) === 'pagos_operacion_unica') return registrarPago(db, p);
    throw e;
  }
}

/** Anula un pago mal registrado (queda en el historial con su motivo) y recalcula el saldo. */
export async function anularPago(db: Db, empresaId: string, pagoId: string, motivo: string, usuarioId?: string): Promise<EstadoCobro> {
  if (!motivo.trim()) throw new Error('Indica el motivo para anular el pago.');
  return enTransaccion(db, async (tx) => {
    const r = await tx.query(
      `UPDATE pagos SET anulado_en = now(), anulado_motivo = $3 WHERE id = $1 AND empresa_id = $2 AND anulado_en IS NULL RETURNING comprobante_id`,
      [pagoId, empresaId, motivo.trim()],
    );
    const comprobanteId = r.rows[0]?.comprobante_id as string | undefined;
    if (!comprobanteId) throw new Error('El pago no existe o ya estaba anulado.');
    await tx.query(`SELECT 1 FROM comprobantes WHERE id = $1 FOR UPDATE`, [comprobanteId]);
    await tx.query(
      `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, motivo) VALUES ($1, $2, 'ANULAR_PAGO', 'pagos', $3, $4)`,
      [empresaId, usuarioId ?? null, pagoId, motivo.trim()],
    );
    return recalcularCobro(tx, comprobanteId);
  });
}

/**
 * Alertas de cuotas: ROJO si venció sin pagarse, AMARILLO si vence en los próximos 3 días.
 * Se puede llamar en cada vuelta del cron: no duplica alertas abiertas.
 */
export async function revisarVencimientos(db: Db, hoy = ahoraLima().fecha): Promise<number> {
  const r = await db.query(
    `SELECT q.id, q.numero_cuota, q.monto, q.monto_pagado, to_char(q.fecha_vencimiento, 'YYYY-MM-DD') AS vence,
            c.empresa_id, c.serie, c.numero, c.cliente_nombre, (q.fecha_vencimiento < $1::date) AS vencida
     FROM comprobante_cuotas q JOIN comprobantes c ON c.id = q.comprobante_id
     WHERE NOT q.pagada AND c.estado NOT IN ('RECHAZADO', 'ANULADO') AND q.fecha_vencimiento <= $1::date + 3`,
    [hoy],
  );
  for (const q of r.rows) {
    const pendiente = dec(q.monto as string).minus(dec(q.monto_pagado as string)).toFixed(2);
    const nombre = idComprobanteLegible(q.serie, Number(q.numero));
    await crearAlerta(db, {
      empresaId: q.empresa_id,
      tipo: q.vencida ? 'CUOTA_VENCIDA' : 'CUOTA_POR_VENCER',
      severidad: q.vencida ? 'ROJO' : 'AMARILLO',
      mensaje: `${q.vencida ? 'Venció' : 'Vence'} el ${q.vence} la cuota ${q.numero_cuota} de ${nombre} (${q.cliente_nombre}): faltan S/ ${pendiente}.`,
      entidad: 'comprobante_cuotas',
      entidadId: q.id,
    });
  }
  return r.rowCount ?? 0;
}

/** Pagos de un comprobante (incluidos los anulados, para el historial). */
export async function pagosDe(q: Db | Tx, comprobanteId: string) {
  const r = await q.query(
    `SELECT id, to_char(fecha, 'YYYY-MM-DD') AS fecha, monto, medio, referencia_operacion AS referencia, anulado_en IS NOT NULL AS anulado
     FROM pagos WHERE comprobante_id = $1 ORDER BY creado_en`,
    [comprobanteId],
  );
  return r.rows.map((f) => ({ id: f.id as string, fecha: f.fecha as string, monto: f.monto as string, medio: f.medio as MedioPago, referencia: f.referencia as string | null, anulado: f.anulado as boolean }));
}

