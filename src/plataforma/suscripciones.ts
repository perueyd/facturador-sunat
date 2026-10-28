/**
 * El facturador como servicio: planes, suscripciones y cobro a cada cliente.
 *
 * Una empresa SIN suscripción es propia del dueño de la plataforma: no tiene límites.
 * Con suscripción, el estado se deduce de la fecha pagada:
 *   PRUEBA / ACTIVA → POR_VENCER (7 días antes) → EN_GRACIA (puede emitir, con aviso)
 *   → VENCIDA (ya no emite boletas ni facturas nuevas). SUSPENDIDA y CANCELADA las pone el administrador.
 *
 * Lo que NUNCA se bloquea por falta de pago, porque son obligaciones del cliente con SUNAT:
 * enviar lo que quedó en cola, consultar y descargar sus comprobantes (PDF, XML, CDR),
 * notas de crédito y comunicaciones de baja. Solo se frena emitir boletas y facturas NUEVAS.
 */
import type { Db, Tx } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { ahoraLima } from '../fechas.js';

export const DIAS_PRUEBA = 14;
const DIAS_POR_VENCER = 7;

export type EstadoSuscripcion = 'PRUEBA' | 'ACTIVA' | 'POR_VENCER' | 'EN_GRACIA' | 'VENCIDA' | 'SUSPENDIDA' | 'CANCELADA';

export interface Suscripcion {
  plan: string;
  nombrePlan: string;
  estado: EstadoSuscripcion;
  venceEn: string;
  /** Días que faltan para el vencimiento (negativo si ya pasó). */
  dias: number;
  diasGracia: number;
  usoMes: number;
  limiteMes: number | null;
  usuarios: number;
  limiteUsuarios: number | null;
  precioMensual: string;
  precioAnual: string;
  /** Si puede emitir boletas y facturas nuevas; si no, `motivo` explica por qué en español claro. */
  puedeEmitir: boolean;
  motivo?: string;
}

/** Lo que cuenta para el límite del plan: boletas y facturas del mes (las rechazadas no). */
const SQL_USO_MES = `(SELECT count(*) FROM comprobantes c WHERE c.empresa_id = s.empresa_id AND c.tipo_comprobante IN ('01', '03')
   AND c.estado <> 'RECHAZADO' AND c.fecha_emision >= date_trunc('month', $2::date))::int`;
const SQL_USUARIOS = `(SELECT count(*) FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id WHERE ue.empresa_id = s.empresa_id AND u.activo)::int`;

function deducir(f: Record<string, unknown>): Suscripcion {
  const dias = f.dias as number;
  const diasGracia = f.dias_gracia as number;
  const guardado = f.estado as 'PRUEBA' | 'ACTIVA' | 'SUSPENDIDA' | 'CANCELADA';
  let estado: EstadoSuscripcion = guardado;
  if (guardado === 'PRUEBA' || guardado === 'ACTIVA') {
    if (dias < -diasGracia) estado = 'VENCIDA';
    else if (dias < 0) estado = 'EN_GRACIA';
    else if (dias <= DIAS_POR_VENCER && guardado === 'ACTIVA') estado = 'POR_VENCER';
  }
  const usoMes = f.uso_mes as number;
  const limiteMes = f.comprobantes_mes as number | null;
  const s: Suscripcion = {
    plan: f.plan_codigo as string, nombrePlan: f.nombre as string, estado, venceEn: f.vence_en as string, dias, diasGracia,
    usoMes, limiteMes, usuarios: f.usuarios as number, limiteUsuarios: f.usuarios_max as number | null,
    precioMensual: dec(f.precio_mensual as string).toFixed(2), precioAnual: dec(f.precio_anual as string).toFixed(2), puedeEmitir: true,
  };
  const prueba = guardado === 'PRUEBA' ? 'El periodo de prueba' : 'Tu plan';
  if (estado === 'VENCIDA') {
    s.puedeEmitir = false;
    s.motivo = `${prueba} venció el ${s.venceEn}. Renueva tu plan para seguir emitiendo boletas y facturas. Tus comprobantes anteriores siguen disponibles.`;
  } else if (estado === 'SUSPENDIDA' || estado === 'CANCELADA') {
    s.puedeEmitir = false;
    s.motivo = `Tu plan está ${estado === 'SUSPENDIDA' ? 'suspendido' : 'cancelado'}. Comunícate con tu proveedor del facturador. Tus comprobantes anteriores siguen disponibles.`;
  } else if (limiteMes !== null && usoMes >= limiteMes) {
    s.puedeEmitir = false;
    s.motivo = `Llegaste al límite de tu plan ${s.nombrePlan}: ${limiteMes} comprobantes este mes. Cambia a un plan mayor para seguir emitiendo.`;
  }
  return s;
}

const SELECT_SUSCRIPCION = `
  SELECT s.empresa_id, s.plan_codigo, s.estado, s.vence_en::text AS vence_en, s.dias_gracia, s.contacto, s.notas,
         (s.vence_en - $2::date)::int AS dias, p.nombre, p.precio_mensual::text, p.precio_anual::text, p.comprobantes_mes, p.usuarios_max,
         ${SQL_USO_MES} AS uso_mes, ${SQL_USUARIOS} AS usuarios,
         (SELECT periodo FROM pagos_suscripcion WHERE empresa_id = s.empresa_id ORDER BY id DESC LIMIT 1) AS ultimo_periodo
    FROM suscripciones s JOIN planes p ON p.codigo = s.plan_codigo`;

/** Suscripción de la empresa, o undefined si es propia (sin límites). */
export async function suscripcionDe(db: Db | Tx, empresaId: string, hoy = ahoraLima().fecha): Promise<Suscripcion | undefined> {
  const f = (await db.query(`${SELECT_SUSCRIPCION} WHERE s.empresa_id = $1`, [empresaId, hoy])).rows[0];
  return f ? deducir(f) : undefined;
}

/** Empresa nueva de un cliente: empieza con días de prueba en el plan indicado. */
export async function iniciarPrueba(db: Db | Tx, d: { empresaId: string; plan?: string; contacto?: string; hoy?: string }): Promise<void> {
  await db.query(
    `INSERT INTO suscripciones (empresa_id, plan_codigo, estado, vence_en, contacto) VALUES ($1, $2, 'PRUEBA', $3::date + $4::int, $5)`,
    [d.empresaId, d.plan ?? 'EMPRENDEDOR', d.hoy ?? ahoraLima().fecha, DIAS_PRUEBA, d.contacto ?? null],
  );
}

export class ErrorSuscripcion extends Error {}

/**
 * Registra un pago y extiende el plan un mes o un año. Si todavía no venció, se suma desde
 * el vencimiento (no pierde días por pagar antes); si ya venció, desde hoy.
 */
export async function registrarPago(
  db: Db,
  d: { empresaId: string; periodo: 'MENSUAL' | 'ANUAL'; monto?: string; medio: string; referencia?: string; plan?: string; usuarioId: string; hoy?: string },
): Promise<{ hasta: string; monto: string }> {
  const hoy = d.hoy ?? ahoraLima().fecha;
  if (!['MENSUAL', 'ANUAL'].includes(d.periodo)) throw new ErrorSuscripcion('Elige mensual o anual.');
  if (!d.medio.trim()) throw new ErrorSuscripcion('Indica cómo pagó (Yape, transferencia…).');
  const actual = (await db.query(`SELECT plan_codigo, vence_en::text AS vence_en FROM suscripciones WHERE empresa_id = $1`, [d.empresaId])).rows[0];
  if (!actual) throw new ErrorSuscripcion('Esta empresa no tiene plan (es propia).');
  const plan = (await db.query(`SELECT codigo, precio_mensual::text, precio_anual::text FROM planes WHERE codigo = $1 AND activo`, [d.plan ?? actual.plan_codigo])).rows[0];
  if (!plan) throw new ErrorSuscripcion('Ese plan no existe o ya no se ofrece.');
  const precio = d.periodo === 'ANUAL' ? plan.precio_anual : plan.precio_mensual;
  if (d.monto !== undefined && !/^\d{1,8}(\.\d{1,2})?$/.test(d.monto)) throw new ErrorSuscripcion('El monto debe ser como 39.00.');
  const monto = dec(d.monto ?? precio).toFixed(2);
  const fechas = (await db.query(
    `SELECT greatest($1::date, $2::date)::text AS desde, (greatest($1::date, $2::date) + ($3 = 'ANUAL')::int * interval '1 year' + ($3 = 'MENSUAL')::int * interval '1 month')::date::text AS hasta`,
    [actual.vence_en, hoy, d.periodo],
  )).rows[0];
  await db.query(
    `INSERT INTO pagos_suscripcion (empresa_id, plan_codigo, periodo, monto, medio, referencia, desde, hasta, registrado_por) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [d.empresaId, plan.codigo, d.periodo, monto, d.medio.trim().slice(0, 60), d.referencia?.trim().slice(0, 120) || null, fechas.desde, fechas.hasta, d.usuarioId],
  );
  await db.query(
    `UPDATE suscripciones SET plan_codigo = $2, estado = 'ACTIVA', vence_en = $3, actualizado_en = now() WHERE empresa_id = $1`,
    [d.empresaId, plan.codigo, fechas.hasta],
  );
  await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'PAGO_SUSCRIPCION', 'empresas', $1, $3)`, [
    d.empresaId, d.usuarioId, JSON.stringify({ plan: plan.codigo, periodo: d.periodo, monto, hasta: fechas.hasta }),
  ]);
  return { hasta: fechas.hasta, monto };
}

/** Cambia el plan o el estado (suspender, reactivar, cancelar) dejando constancia de quién y por qué. */
export async function cambiarSuscripcion(
  db: Db,
  d: { empresaId: string; usuarioId: string; plan?: string; estado?: 'ACTIVA' | 'SUSPENDIDA' | 'CANCELADA'; motivo: string },
): Promise<void> {
  if (!d.motivo.trim()) throw new ErrorSuscripcion('Escribe el motivo (queda en el historial).');
  if (d.plan && !(await db.query(`SELECT 1 FROM planes WHERE codigo = $1 AND activo`, [d.plan])).rowCount) throw new ErrorSuscripcion('Ese plan no existe.');
  if (d.estado && !['ACTIVA', 'SUSPENDIDA', 'CANCELADA'].includes(d.estado)) throw new ErrorSuscripcion('Estado inválido.');
  const r = await db.query(
    `UPDATE suscripciones SET plan_codigo = coalesce($2, plan_codigo), estado = coalesce($3, estado), actualizado_en = now() WHERE empresa_id = $1 RETURNING 1`,
    [d.empresaId, d.plan ?? null, d.estado ?? null],
  );
  if (!r.rowCount) throw new ErrorSuscripcion('Esta empresa no tiene plan (es propia).');
  await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'CAMBIO_SUSCRIPCION', 'empresas', $1, $3)`, [
    d.empresaId, d.usuarioId, JSON.stringify({ plan: d.plan ?? null, estado: d.estado ?? null, motivo: d.motivo.trim().slice(0, 300) }),
  ]);
}

export interface FilaCliente {
  empresaId: string;
  ruc: string;
  razonSocial: string;
  ambiente: string;
  suscripcion: Suscripcion | null;
  contacto: string | null;
  certificadoVence: string | null;
  pendientes: number;
  rechazados7d: number;
  ultimoComprobante: string | null;
}

/** Todas las empresas de la plataforma, con su plan, uso y salud. Para el panel del administrador. */
export async function clientes(db: Db, hoy = ahoraLima().fecha): Promise<{ clientes: FilaCliente[]; resumen: { activos: number; prueba: number; vencidos: number; porVencer: number; ingresoMensual: string } }> {
  const subs = new Map<string, Record<string, unknown>>();
  for (const f of (await db.query(`${SELECT_SUSCRIPCION} WHERE $1::uuid IS NULL`, [null, hoy])).rows) subs.set(f.empresa_id as string, f);
  const r = await db.query(
    `SELECT e.id, e.ruc, e.razon_social, e.ambiente_sunat::text AS ambiente,
            (SELECT valido_hasta::date::text FROM certificados WHERE empresa_id = e.id AND activo) AS cert,
            (SELECT count(*) FROM comprobantes WHERE empresa_id = e.id AND estado IN ('EMITIDO_LOCAL', 'PENDIENTE_ENVIO'))::int AS pendientes,
            (SELECT count(*) FROM comprobantes WHERE empresa_id = e.id AND estado = 'RECHAZADO' AND creado_en > now() - interval '7 days')::int AS rechazados,
            (SELECT max(fecha_emision)::text FROM comprobantes WHERE empresa_id = e.id) AS ultimo
       FROM empresas e ORDER BY e.razon_social`,
  );
  let ingreso = dec('0');
  const resumen = { activos: 0, prueba: 0, vencidos: 0, porVencer: 0, ingresoMensual: '0.00' };
  const filas = r.rows.map((e): FilaCliente => {
    const f = subs.get(e.id as string);
    const s = f ? deducir(f) : null;
    if (s) {
      if (s.estado === 'PRUEBA') resumen.prueba++;
      else if (s.estado === 'VENCIDA' || s.estado === 'EN_GRACIA') resumen.vencidos++;
      else if (s.estado === 'ACTIVA' || s.estado === 'POR_VENCER') {
        resumen.activos++;
        // Ingreso mensual recurrente estimado: quien paga anual cuenta como la doceava parte.
        ingreso = ingreso.plus(f?.ultimo_periodo === 'ANUAL' ? dec(s.precioAnual).div(12) : dec(s.precioMensual));
      }
      if (s.estado === 'POR_VENCER') resumen.porVencer++;
    }
    return {
      empresaId: e.id, ruc: e.ruc, razonSocial: e.razon_social, ambiente: e.ambiente, suscripcion: s, contacto: (f?.contacto as string | null) ?? null,
      certificadoVence: e.cert, pendientes: e.pendientes, rechazados7d: e.rechazados, ultimoComprobante: e.ultimo,
    };
  });
  resumen.ingresoMensual = ingreso.toFixed(2);
  return { clientes: filas, resumen };
}
