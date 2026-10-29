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
import { sqlSaldo } from '../cobros/pagos.js';
import type { Db } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { ahoraLima } from '../fechas.js';

export const MODULOS = ['panel', 'vencimientos', 'resumen', 'certificado', 'cobros', 'notas', 'productos', 'exportar', 'compras', 'avisos', 'estadisticas'] as const;
export type Modulo = (typeof MODULOS)[number];
/** Secciones que se reparten por plan. Las demás van siempre (son para cumplir con SUNAT). */
export const SECCIONES_DE_PLAN = ['cobros', 'productos', 'compras', 'estadisticas'] as const satisfies readonly Modulo[];

/** Columna del cronograma según el último dígito del RUC (o la de Buenos Contribuyentes). */
export function grupoCronograma(ruc: string, buenContribuyente: boolean): string {
  if (buenContribuyente) return 'BC';
  const d = Number(ruc.at(-1));
  return d <= 1 ? String(d) : `${d - (d % 2)}-${d - (d % 2) + 1}`;
}

const diasEntre = (desde: string, hasta: string) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
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
  certificado?: { vence: string; dias: number } | { falta: true };
  sunat?: { pendientes: number; rechazados: number };
  cobros?: { comprobantes: number; saldo: string };
}

export async function tablero(db: Db, empresaId: string, opciones: { hoy?: string; modulos?: readonly Modulo[] } = {}): Promise<Tablero> {
  const hoy = opciones.hoy ?? ahoraLima().fecha;
  const activo = (m: Modulo) => !opciones.modulos || opciones.modulos.includes(m);
  const e = (await db.query(`SELECT ruc, buen_contribuyente FROM empresas WHERE id = $1`, [empresaId])).rows[0];
  const t: Tablero = { hoy };

  // El período que toca declarar es el del PRÓXIMO vencimiento (hoy en adelante).
  const grupo = grupoCronograma(e.ruc as string, e.buen_contribuyente as boolean);
  const v = (await db.query(
    `SELECT periodo, vence::text AS vence, fuente FROM cronograma_mensual WHERE grupo = $1 AND vence >= $2::date ORDER BY vence LIMIT 1`,
    [grupo, hoy],
  )).rows[0];
  const periodo = (v?.periodo as string | undefined) ?? hoy.slice(0, 7);
  if (activo('vencimientos')) {
    t.vencimiento = v
      ? { periodo, nombre: nombrePeriodo(periodo), vence: v.vence, dias: diasEntre(hoy, v.vence), grupo, fuente: v.fuente }
      : { faltaCronograma: true };
  }

  if (activo('resumen')) {
    // Ventas del período: boletas y facturas suman; sus notas de crédito restan.
    const ventas = (await db.query(
      `SELECT coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -importe_total ELSE importe_total END), 0)::text AS total,
              coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -(total_gravado + total_exonerado + total_inafecto) ELSE total_gravado + total_exonerado + total_inafecto END), 0)::text AS base,
              coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -total_igv ELSE total_igv END), 0)::text AS igv
         FROM comprobantes
        WHERE empresa_id = $1 AND to_char(fecha_emision, 'YYYY-MM') = $2 AND estado NOT IN ('RECHAZADO', 'ANULADO')`,
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
    t.resumen = {
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
       FROM comprobantes WHERE empresa_id = $1`,
    [empresaId, hoy],
  )).rows[0];
  t.sunat = { pendientes: s.pendientes, rechazados: s.rechazados };

  if (activo('cobros')) {
    const p = (await db.query(
      `SELECT count(*)::int AS n, coalesce(sum(${sqlSaldo('c')}), 0)::text AS saldo FROM comprobantes c
        WHERE c.empresa_id = $1 AND c.tipo_comprobante <> '07' AND c.estado_pago <> 'PAGADO' AND c.estado NOT IN ('RECHAZADO', 'ANULADO')`,
      [empresaId],
    )).rows[0];
    t.cobros = { comprobantes: p.n, saldo: dec(p.saldo).toFixed(2) };
  }
  return t;
}
