/**
 * Aliados: personas que venden el facturador a otros negocios y ganan una comisión.
 *
 * - El dueño de la plataforma nombra aliados (por su correo, que ya debe tener cuenta) y fija su %.
 * - El aliado da de alta empresas: quedan a su nombre, en prueba, y él invita al dueño del negocio.
 *   NO queda como usuario de esas empresas: no ve sus comprobantes ni sus datos.
 * - Cuando el dueño de la plataforma registra un pago del cliente, se guarda la comisión DEL
 *   MOMENTO (% y monto). Cambiar el % después no cambia lo ya ganado. Un aliado desactivado
 *   deja de ganar comisión por los pagos nuevos.
 * - Lo que se le paga al aliado se registra aparte (solo inserción) y nunca supera lo ganado.
 * Montos exactos (NUMERIC / decimal.js). Todo queda en la auditoría.
 */
import { enTransaccion, type Db, type Tx } from '../db/conexion.js';
import { dec } from '../dinero.js';

export class ErrorAliado extends Error {}

const PORCENTAJE = /^\d{1,3}(\.\d{1,2})?$/;

function validarComision(comision: string): string {
  if (!PORCENTAJE.test(comision) || dec(comision).gt(100)) throw new ErrorAliado('La comisión es un % de 0 a 100, por ejemplo 20 o 12.5.');
  return dec(comision).toFixed(2);
}

/** Datos del aliado para su sesión, o undefined si no es aliado (o está desactivado). */
export async function aliadoActivo(q: Db | Tx, usuarioId: string): Promise<{ comision: string } | undefined> {
  const f = (await q.query(`SELECT comision::text AS comision FROM aliados WHERE usuario_id = $1 AND activo`, [usuarioId])).rows[0];
  return f ? { comision: dec(f.comision).toFixed(2) } : undefined;
}

/** Nombra aliado a una persona que ya tiene cuenta activa, o cambia su % o lo reactiva. */
export async function nombrarAliado(db: Db, d: { email: string; comision: string; porUsuario: string }): Promise<{ usuarioId: string; nombre: string }> {
  const comision = validarComision(d.comision);
  const u = (await db.query(`SELECT id, nombre FROM usuarios WHERE lower(email) = lower($1) AND activo AND totp_activo`, [d.email.trim()])).rows[0];
  if (!u) throw new ErrorAliado('No hay una cuenta activa con ese correo. Primero invítalo a una empresa (por ejemplo como Contador) y que active su acceso.');
  await enTransaccion(db, async (tx) => {
    await tx.query(
      `INSERT INTO aliados (usuario_id, comision, creado_por) VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id) DO UPDATE SET comision = EXCLUDED.comision, activo = true, actualizado_en = now()`,
      [u.id, comision, d.porUsuario],
    );
    await tx.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'NOMBRAR_ALIADO', 'aliados', $2, $3)`, [
      d.porUsuario, u.id, JSON.stringify({ comision }),
    ]);
  });
  return { usuarioId: u.id as string, nombre: u.nombre as string };
}

/** Desactiva a un aliado: ya no da de alta empresas ni gana comisión nueva. Sus clientes y su historial quedan. */
export async function desactivarAliado(db: Db, d: { aliadoId: string; porUsuario: string; motivo: string }): Promise<boolean> {
  if (d.motivo.trim().length < 3) throw new ErrorAliado('Escribe el motivo (queda en el historial).');
  return enTransaccion(db, async (tx) => {
    const r = await tx.query(`UPDATE aliados SET activo = false, actualizado_en = now() WHERE usuario_id = $1 AND activo RETURNING 1`, [d.aliadoId]);
    if (r.rowCount) {
      await tx.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, motivo) VALUES ($1, 'DESACTIVAR_ALIADO', 'aliados', $2, $3)`, [
        d.porUsuario, d.aliadoId, d.motivo.trim().slice(0, 300),
      ]);
    }
    return Boolean(r.rowCount);
  });
}

/** El dueño de la plataforma asigna (o quita, con null) el aliado que trajo a un cliente. */
export async function asignarAliado(db: Db, d: { empresaId: string; aliadoId: string | null; porUsuario: string }): Promise<void> {
  await enTransaccion(db, async (tx) => {
    if (d.aliadoId && !(await tx.query(`SELECT 1 FROM aliados WHERE usuario_id = $1`, [d.aliadoId])).rowCount) throw new ErrorAliado('Ese aliado no existe.');
    const r = await tx.query(`UPDATE suscripciones SET aliado_id = $2, actualizado_en = now() WHERE empresa_id = $1 RETURNING 1`, [d.empresaId, d.aliadoId]);
    if (!r.rowCount) throw new ErrorAliado('Esta empresa no tiene plan (es propia): no lleva aliado.');
    await tx.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'ASIGNAR_ALIADO', 'empresas', $1, $3)`, [
      d.empresaId, d.porUsuario, JSON.stringify({ aliado: d.aliadoId }),
    ]);
  });
}

/** Comisión de un pago de suscripción (dentro de la transacción del pago). Sin aliado activo: ninguna. */
export async function comisionDelPago(tx: Tx, empresaId: string, monto: string): Promise<{ aliadoId: string; porcentaje: string; monto: string } | undefined> {
  const a = (await tx.query(
    `SELECT a.usuario_id, a.comision::text AS comision FROM suscripciones s JOIN aliados a ON a.usuario_id = s.aliado_id
      WHERE s.empresa_id = $1 AND a.activo`,
    [empresaId],
  )).rows[0];
  if (!a) return undefined;
  return { aliadoId: a.usuario_id as string, porcentaje: dec(a.comision).toFixed(2), monto: dec(monto).times(dec(a.comision)).div(100).toDecimalPlaces(2).toFixed(2) };
}

/** Lo ganado, lo pagado y lo que se le debe a un aliado (o a todos). */
async function saldos(q: Db | Tx, aliadoId: string | null) {
  return (await q.query(
    `SELECT a.usuario_id, u.nombre, u.email, a.comision::text AS comision, a.activo,
            (SELECT count(*) FROM suscripciones WHERE aliado_id = a.usuario_id)::int AS clientes,
            (SELECT coalesce(sum(comision_monto), 0) FROM pagos_suscripcion WHERE aliado_id = a.usuario_id)::text AS ganado,
            (SELECT coalesce(sum(monto), 0) FROM pagos_aliado WHERE aliado_id = a.usuario_id)::text AS pagado
       FROM aliados a JOIN usuarios u ON u.id = a.usuario_id
      WHERE $1::uuid IS NULL OR a.usuario_id = $1
      ORDER BY a.activo DESC, u.nombre`,
    [aliadoId],
  )).rows.map((f) => ({
    aliadoId: f.usuario_id as string, nombre: f.nombre as string, email: f.email as string, comision: dec(f.comision).toFixed(2), activo: f.activo as boolean,
    clientes: f.clientes as number, ganado: dec(f.ganado).toFixed(2), pagado: dec(f.pagado).toFixed(2), porPagar: dec(f.ganado).minus(dec(f.pagado)).toFixed(2),
  }));
}

/** Para el dueño de la plataforma: todos los aliados con lo que se les debe. */
export const listarAliados = (db: Db) => saldos(db, null);

/** Registra lo que se le pagó al aliado. No puede pasar de lo que tiene por cobrar. */
export async function pagarAliado(
  db: Db,
  d: { aliadoId: string; monto: string; medio: string; referencia?: string; porUsuario: string },
): Promise<{ porPagar: string }> {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(d.monto) || !dec(d.monto).gt(0)) throw new ErrorAliado('El monto debe ser como 45.50.');
  if (!d.medio.trim()) throw new ErrorAliado('Indica cómo le pagaste (Yape, transferencia…).');
  return enTransaccion(db, async (tx) => {
    // Se bloquea al aliado: dos pagos a la vez no pueden pasarse de lo que se le debe.
    if (!(await tx.query(`SELECT 1 FROM aliados WHERE usuario_id = $1 FOR UPDATE`, [d.aliadoId])).rowCount) throw new ErrorAliado('Ese aliado no existe.');
    const s = (await saldos(tx, d.aliadoId))[0]!;
    if (dec(d.monto).gt(dec(s.porPagar))) throw new ErrorAliado(`El pago (S/ ${dec(d.monto).toFixed(2)}) supera lo que tiene por cobrar (S/ ${s.porPagar}).`);
    const id = (await tx.query(
      `INSERT INTO pagos_aliado (aliado_id, monto, medio, referencia, registrado_por) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [d.aliadoId, dec(d.monto).toFixed(2), d.medio.trim().slice(0, 60), d.referencia?.trim().slice(0, 120) || null, d.porUsuario],
    )).rows[0].id as string;
    await tx.query(`INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, 'PAGAR_ALIADO', 'aliados', $2, $3)`, [
      d.porUsuario, d.aliadoId, JSON.stringify({ pago: String(id), monto: dec(d.monto).toFixed(2), medio: d.medio.trim() }),
    ]);
    return { porPagar: dec(s.porPagar).minus(dec(d.monto)).toFixed(2) };
  });
}

/** Para el aliado: su %, lo ganado por mes (últimos 12), lo pagado y lo que tiene por cobrar. */
export async function comisionesDelAliado(db: Db, aliadoId: string, hoy: string) {
  const s = (await saldos(db, aliadoId))[0];
  if (!s) throw new ErrorAliado('No eres aliado.');
  const meses = (await db.query(
    `SELECT to_char(creado_en AT TIME ZONE 'America/Lima', 'YYYY-MM') AS mes, count(*)::int AS pagos, sum(comision_monto)::text AS comision
       FROM pagos_suscripcion WHERE aliado_id = $1 AND (creado_en AT TIME ZONE 'America/Lima')::date >= date_trunc('month', $2::date) - interval '11 months'
      GROUP BY 1 ORDER BY 1 DESC`,
    [aliadoId, hoy],
  )).rows.map((f) => ({ mes: f.mes as string, pagos: f.pagos as number, comision: dec(f.comision).toFixed(2) }));
  const pagosRecibidos = (await db.query(
    `SELECT (creado_en AT TIME ZONE 'America/Lima')::date::text AS fecha, monto::text AS monto, medio FROM pagos_aliado WHERE aliado_id = $1 ORDER BY id DESC LIMIT 12`,
    [aliadoId],
  )).rows.map((f) => ({ fecha: f.fecha as string, monto: dec(f.monto).toFixed(2), medio: f.medio as string }));
  const esteMes = meses.find((m) => m.mes === hoy.slice(0, 7))?.comision ?? '0.00';
  return { comision: s.comision, activo: s.activo, clientes: s.clientes, ganadoMes: esteMes, ganado: s.ganado, pagado: s.pagado, porPagar: s.porPagar, meses, pagosRecibidos };
}

/**
 * ¿Puede el aliado invitar al dueño de esta empresa? Solo si la trajo él y si todavía no tiene
 * un dueño que ya activó su acceso: así no puede volverse dueño de un cliente que ya funciona.
 */
export async function aliadoPuedeInvitar(db: Db, aliadoId: string, empresaId: string): Promise<'SI' | 'NO_ES_SUYA' | 'YA_TIENE_DUENO'> {
  const f = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM suscripciones WHERE empresa_id = $2 AND aliado_id = $1) AS suya,
            EXISTS (SELECT 1 FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id
                     WHERE ue.empresa_id = $2 AND ue.rol = 'DUENO' AND u.totp_activo) AS con_dueno`,
    [aliadoId, empresaId],
  )).rows[0];
  if (!f.suya) return 'NO_ES_SUYA';
  return f.con_dueno ? 'YA_TIENE_DUENO' : 'SI';
}
