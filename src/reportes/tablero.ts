/**
 * Tablero del panel: lo que el dueño necesita ver al entrar.
 *   - Próximo vencimiento de la declaración mensual (cronograma oficial de SUNAT según el
 *     último dígito del RUC) y cuántos días quedan.
 *   - Resumen del mes que se va a declarar: ventas, IGV cobrado, IGV de compras, IGV y pago
 *     a cuenta de Renta ESTIMADOS (los parámetros "POR VERIFICAR" se avisan).
 *   - Certificado digital por vencer, comprobantes pendientes o rechazados por SUNAT y
 *     lo que falta cobrar.
 * Los cálculos de impuestos son SIEMPRE estimados: la declaración la confirma el contador.
 */
import { SQL_SE_COBRA, sqlSaldo } from '../cobros/pagos.js';
import { diasDeContingencia } from '../contingencia/contingencia.js';
import { type Db, sqlDelMes } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { porPagar } from '../inventario/por-pagar.js';
import { ahoraLima, diasEntre } from '../fechas.js';

export const MODULOS = ['panel', 'vencimientos', 'resumen', 'certificado', 'cobros', 'notas', 'productos', 'exportar', 'compras', 'avisos', 'estadisticas', 'antiguos'] as const;
export type Modulo = (typeof MODULOS)[number];
/** Secciones que se reparten por plan. Las demás van siempre (son para cumplir con SUNAT). */
export const SECCIONES_DE_PLAN = ['cobros', 'productos', 'compras', 'estadisticas'] as const satisfies readonly Modulo[];

/** Columna del cronograma según el último dígito del RUC (o la de Buenos Contribuyentes). */
export function grupoCronograma(ruc: string, buenContribuyente: boolean): string {
  if (buenContribuyente) return 'BC';
  const d = Number(ruc.at(-1));
  return d <= 1 ? String(d) : `${d - (d % 2)}-${d - (d % 2) + 1}`;
}

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
export const nombrePeriodo = (periodo: string) => `${NOMBRE_MES[Number(periodo.slice(5, 7)) - 1]} ${periodo.slice(0, 4)}`;

export interface Tablero {
  hoy: string;
  vencimiento?: { periodo: string; nombre: string; vence: string; dias: number; grupo: string; fuente: string } | { faltaCronograma: true };
  resumen?: {
    periodo: string;
    nombre: string;
    ventas: string;
    baseImponible: string;
    igvVentas: string;
    igvCompras: string;
    igvPorPagar: string;
    saldoAFavor: string;
    rentaPagoCuenta?: { monto: string; tasa: string; porVerificar: boolean };
    estimado: true;
  };
  /** Período que ya se marcó como declarado (y cuándo), mientras su vencimiento no pase. */
  declarado?: { periodo: string; nombre: string; el: string };
  /** El mes en curso, cuando no es el que toca declarar (lo acumulado hasta hoy). */
  mesActual?: Tablero['resumen'];
  certificado?: { vence: string; dias: number } | { falta: true };
  sunat?: { pendientes: number; rechazados: number };
  cobros?: { comprobantes: number; saldo: string };
  /** Días con ventas sin internet que aún no se informaron a SUNAT (plazo de 7 días). */
  contingencia?: { dias: number; ventas: number; venceEn: number };
  /** Deudas a proveedores (compras al crédito): solo para quien ve las compras. */
  porPagar?: { saldo: string; vencido: string; vencePronto: string };
}

export async function tablero(db: Db, empresaId: string, opciones: { hoy?: string; modulos?: readonly Modulo[]; porPagar?: boolean } = {}): Promise<Tablero> {
  const hoy = opciones.hoy ?? ahoraLima().fecha;
  const activo = (m: Modulo) => !opciones.modulos || opciones.modulos.includes(m);
  const e = (await db.query(`SELECT ruc, buen_contribuyente FROM empresas WHERE id = $1`, [empresaId])).rows[0];
  const t: Tablero = { hoy };

  // El período que toca declarar es el del PRÓXIMO vencimiento (hoy en adelante).
  const grupo = grupoCronograma(e.ruc as string, e.buen_contribuyente as boolean);
  const v = (await db.query(
    `SELECT periodo, vence::text AS vence, fuente FROM cronograma_mensual
      WHERE grupo = $1 AND vence >= $2::date
        -- Lo ya declarado no se vuelve a pedir: pasa al período siguiente.
        AND periodo NOT IN (SELECT periodo FROM declaraciones_mensuales WHERE empresa_id = $3)
      ORDER BY vence LIMIT 1`,
    [grupo, hoy, empresaId],
  )).rows[0];
  // El último declarado cuyo vencimiento aún no pasó: "✔ octubre ya declarado".
  const declarado = (await db.query(
    `SELECT d.periodo, to_char(d.creado_en AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') AS el FROM declaraciones_mensuales d
       JOIN cronograma_mensual k ON k.periodo = d.periodo AND k.grupo = $2
      WHERE d.empresa_id = $1 AND k.vence >= $3::date ORDER BY d.periodo DESC LIMIT 1`,
    [empresaId, grupo, hoy],
  )).rows[0];
  const periodo = (v?.periodo as string | undefined) ?? hoy.slice(0, 7);
  if (activo('vencimientos')) {
    if (declarado) t.declarado = { periodo: declarado.periodo, nombre: nombrePeriodo(declarado.periodo), el: declarado.el };
    t.vencimiento = v
      ? { periodo, nombre: nombrePeriodo(periodo), vence: v.vence, dias: diasEntre(hoy, v.vence), grupo, fuente: v.fuente }
      : { faltaCronograma: true };
  }

  if (activo('resumen')) {
    t.resumen = await resumenDelPeriodo(db, empresaId, periodo);
    // En noviembre se DECLARA octubre, pero también se quiere ver cómo va noviembre: el mes en
    // curso va aparte (cuando pasa el vencimiento, el Inicio pasa solo al mes siguiente).
    if (hoy.slice(0, 7) !== periodo) t.mesActual = await resumenDelPeriodo(db, empresaId, hoy.slice(0, 7));
  }

  if (activo('certificado')) {
    const c = (await db.query(`SELECT valido_hasta FROM certificados WHERE empresa_id = $1 AND activo`, [empresaId])).rows[0];
    if (c) {
      const vence = ahoraLima(new Date(c.valido_hasta)).fecha;
      t.certificado = { vence, dias: diasEntre(hoy, vence) };
    } else {
      t.certificado = { falta: true };
    }
  }

  // Pendientes con SUNAT (siempre visibles: es lo que más urge corregir).
  const s = (await db.query(
    `SELECT count(*) FILTER (WHERE estado IN ('EMITIDO_LOCAL', 'PENDIENTE_ENVIO'))::int AS pendientes,
            count(*) FILTER (WHERE estado = 'RECHAZADO' AND fecha_emision >= $2::date - 30)::int AS rechazados
       FROM comprobantes
      -- Solo los estados que se cuentan: así se usa el índice (empresa, estado) en vez de recorrer
      -- todos los comprobantes de la empresa cada vez que se abre el Inicio.
      WHERE empresa_id = $1 AND estado IN ('EMITIDO_LOCAL', 'PENDIENTE_ENVIO', 'RECHAZADO')`,
    [empresaId, hoy],
  )).rows[0];
  t.sunat = { pendientes: s.pendientes, rechazados: s.rechazados };
  const sinInformar = (await diasDeContingencia(db, empresaId, hoy)).filter((x) => !x.informado);
  if (sinInformar.length) {
    t.contingencia = { dias: sinInformar.length, ventas: sinInformar.reduce((n, x) => n + x.ventas.length, 0), venceEn: Math.min(...sinInformar.map((x) => x.diasRestantes)) };
  }

  if (activo('cobros')) {
    const p = (await db.query(
      `SELECT count(*)::int AS n, coalesce(sum(${sqlSaldo('c')}), 0)::text AS saldo FROM comprobantes c
        WHERE c.empresa_id = $1 AND c.tipo_comprobante ${SQL_SE_COBRA} AND c.estado_pago <> 'PAGADO' AND c.estado NOT IN ('RECHAZADO', 'ANULADO')`,
      [empresaId],
    )).rows[0];
    t.cobros = { comprobantes: p.n, saldo: dec(p.saldo).toFixed(2) };
  }
  if (opciones.porPagar && activo('compras')) {
    const r = (await porPagar(db, empresaId, hoy)).resumen;
    if (r.total !== '0.00') t.porPagar = { saldo: r.total, vencido: r.vencido, vencePronto: r.vencePronto };
  }
  return t;
}

/** Ventas, IGV y pago a cuenta ESTIMADOS de un mes (AAAA-MM). */
async function resumenDelPeriodo(db: Db, empresaId: string, periodo: string): Promise<NonNullable<Tablero['resumen']>> {
  // Ventas del período (vista ventas_todas: lo emitido aquí, lo impreso sin internet y lo emitido
  // en SUNAT y subido). Boletas y facturas suman; sus notas de crédito restan.
  const ventas = (await db.query(
    `SELECT coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -importe_total ELSE importe_total END), 0)::text AS total,
            coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -1 ELSE 1 END * (total_gravado + total_exonerado + total_inafecto)), 0)::text AS base,
            coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -total_igv ELSE total_igv END), 0)::text AS igv
       FROM ventas_todas
      WHERE empresa_id = $1 AND ${sqlDelMes('fecha_emision', '$2')} AND estado NOT IN ('RECHAZADO', 'ANULADO')`,
    [empresaId, periodo],
  )).rows[0];
  const compras = (await db.query(
    `SELECT coalesce(sum(igv), 0)::text AS igv FROM compras WHERE empresa_id = $1 AND periodo = $2 AND anulada_en IS NULL`,
    [empresaId, periodo],
  )).rows[0];
  const igvVentas = dec(ventas.igv);
  const igvCompras = dec(compras.igv);
  const diferencia = igvVentas.minus(igvCompras);
  const fechaParametros = `${periodo}-01`;
  const renta = (await db.query(
    `SELECT p.valor::text AS tasa, p.fuente
       FROM empresa_regimen er
       JOIN parametros_tributarios p ON p.codigo = 'RMT_PAGO_CUENTA_TASA' AND p.regimen = er.regimen
        AND p.vigente_desde <= $2::date AND (p.vigente_hasta IS NULL OR p.vigente_hasta >= $2::date)
      WHERE er.empresa_id = $1 AND er.vigente_desde <= $2::date AND (er.vigente_hasta IS NULL OR er.vigente_hasta >= $2::date)
      ORDER BY er.vigente_desde DESC, p.vigente_desde DESC LIMIT 1`,
    [empresaId, fechaParametros],
  )).rows[0];
  return {
    periodo,
    nombre: nombrePeriodo(periodo),
    ventas: dec(ventas.total).toFixed(2),
    baseImponible: dec(ventas.base).toFixed(2),
    igvVentas: igvVentas.toFixed(2),
    igvCompras: igvCompras.toFixed(2),
    igvPorPagar: (diferencia.isNegative() ? dec('0') : diferencia).toFixed(2),
    saldoAFavor: (diferencia.isNegative() ? diferencia.negated() : dec('0')).toFixed(2),
    // Solo MYPE Tributario tiene esta tasa configurada; el límite de 300 UIT lo revisa el contador.
    ...(renta
      ? { rentaPagoCuenta: { monto: dec(ventas.base).times(dec(renta.tasa)).toFixed(2), tasa: dec(renta.tasa).times(100).toString(), porVerificar: /POR VERIFICAR/i.test(renta.fuente) } }
      : {}),
    estimado: true,
  };
}
