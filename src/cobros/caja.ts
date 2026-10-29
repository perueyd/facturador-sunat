/**
 * Caja: cuánto dinero entró, a qué cuenta, y el total.
 *
 * Cada cobro dice a qué cuenta entró (el Yape de la empresa, el de una persona, efectivo…).
 * La caja muestra cada cuenta por separado, la suma de las cuentas de la empresa, la de las
 * cuentas de otras personas, y el total. Los cobros anulados no cuentan. Montos exactos
 * (NUMERIC), como texto.
 */
import type { Db } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { MEDIOS_PAGO, type MedioPago } from './pagos.js';

export class ErrorCuenta extends Error {}

export interface Cuenta {
  id: string;
  nombre: string;
  medio: MedioPago;
  titular: string | null;
  deLaEmpresa: boolean;
  predeterminada: boolean;
  activa: boolean;
}

export async function listarCuentas(db: Db, empresaId: string): Promise<Cuenta[]> {
  const r = await db.query(
    `SELECT id, nombre, medio::text AS medio, titular, de_la_empresa, predeterminada, activa FROM cuentas_cobro
      WHERE empresa_id = $1 ORDER BY activa DESC, de_la_empresa DESC, nombre`,
    [empresaId],
  );
  return r.rows.map((f) => ({ id: f.id, nombre: f.nombre, medio: f.medio, titular: f.titular, deLaEmpresa: f.de_la_empresa, predeterminada: f.predeterminada, activa: f.activa }));
}

/** Crea una cuenta o cambia una existente (por id). Ser predeterminada quita esa marca a la anterior del mismo medio. */
export async function guardarCuenta(
  db: Db,
  empresaId: string,
  c: { id?: string; nombre: string; medio: string; titular?: string; deLaEmpresa: boolean; predeterminada: boolean; activa?: boolean },
  usuarioId: string,
): Promise<string> {
  const nombre = c.nombre.trim();
  if (!nombre || nombre.length > 60) throw new ErrorCuenta('Ponle un nombre a la cuenta, por ejemplo "Yape de la empresa".');
  if (!MEDIOS_PAGO.includes(c.medio as MedioPago)) throw new ErrorCuenta('Elige el medio: Yape, Plin, efectivo, transferencia o tarjeta.');
  const activa = c.activa ?? true;
  const predeterminada = c.predeterminada && activa;
  try {
    if (predeterminada) {
      await db.query(`UPDATE cuentas_cobro SET predeterminada = false WHERE empresa_id = $1 AND medio = $2 AND ($3::uuid IS NULL OR id <> $3)`, [empresaId, c.medio, c.id ?? null]);
    }
    const r = c.id
      ? await db.query(
        // Un titular que no se manda se conserva (ej. al solo desactivar la cuenta).
        `UPDATE cuentas_cobro SET nombre = $3, medio = $4, titular = CASE WHEN $9 THEN $5 ELSE titular END, de_la_empresa = $6, predeterminada = $7, activa = $8
          WHERE id = $1 AND empresa_id = $2 RETURNING id`,
        [c.id, empresaId, nombre, c.medio, c.titular?.trim() || null, c.deLaEmpresa, predeterminada, activa, c.titular !== undefined],
      )
      : await db.query(
        `INSERT INTO cuentas_cobro (empresa_id, nombre, medio, titular, de_la_empresa, predeterminada) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [empresaId, nombre, c.medio, c.titular?.trim() || null, c.deLaEmpresa, predeterminada],
      );
    const id = r.rows[0]?.id as string | undefined;
    if (!id) throw new ErrorCuenta('Cuenta no encontrada.');
    await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'GUARDAR_CUENTA_COBRO', 'cuentas_cobro', $3, $4)`, [
      empresaId, usuarioId, id, JSON.stringify({ nombre, medio: c.medio, titular: c.titular ?? null, deLaEmpresa: c.deLaEmpresa, predeterminada, activa }),
    ]);
    return id;
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === '23505') throw new ErrorCuenta('Ya tienes una cuenta con ese nombre.');
    throw e;
  }
}

export interface FilaCaja {
  cuentaId: string | null;
  nombre: string;
  medio: string;
  titular: string | null;
  deLaEmpresa: boolean;
  cobros: number;
  monto: string;
}

export interface Caja {
  desde: string;
  hasta: string;
  cuentas: FilaCaja[];
  totales: { empresa: string; terceros: string; total: string; cobros: number };
  /** Lo vendido en el período (boletas y facturas, menos notas de crédito), para comparar con lo cobrado. */
  vendido: string;
}

/** Caja de un período (fechas AAAA-MM-DD, ambas incluidas). */
export async function caja(db: Db, empresaId: string, desde: string, hasta: string): Promise<Caja> {
  const r = await db.query(
    `SELECT k.id AS cuenta_id, coalesce(k.nombre, 'Sin cuenta: ' || initcap(p.medio::text)) AS nombre, p.medio::text AS medio,
            k.titular, coalesce(k.de_la_empresa, true) AS de_la_empresa, count(*)::int AS cobros, sum(p.monto)::text AS monto
       FROM pagos p LEFT JOIN cuentas_cobro k ON k.id = p.cuenta_id
      WHERE p.empresa_id = $1 AND p.anulado_en IS NULL AND p.fecha BETWEEN $2::date AND $3::date
      GROUP BY k.id, p.medio ORDER BY sum(p.monto) DESC`,
    [empresaId, desde, hasta],
  );
  let empresa = dec('0');
  let terceros = dec('0');
  let cobros = 0;
  const cuentas = r.rows.map((f): FilaCaja => {
    const monto = dec(f.monto);
    if (f.de_la_empresa) empresa = empresa.plus(monto);
    else terceros = terceros.plus(monto);
    cobros += f.cobros as number;
    return { cuentaId: f.cuenta_id, nombre: f.nombre, medio: f.medio, titular: f.titular, deLaEmpresa: f.de_la_empresa, cobros: f.cobros, monto: monto.toFixed(2) };
  });
  const v = (await db.query(
    `SELECT coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -importe_total ELSE importe_total END), 0)::text AS total
       FROM comprobantes WHERE empresa_id = $1 AND estado NOT IN ('RECHAZADO', 'ANULADO') AND fecha_emision BETWEEN $2::date AND $3::date`,
    [empresaId, desde, hasta],
  )).rows[0];
  return {
    desde, hasta, cuentas,
    totales: { empresa: empresa.toFixed(2), terceros: terceros.toFixed(2), total: empresa.plus(terceros).toFixed(2), cobros },
    vendido: dec(v.total).toFixed(2),
  };
}
