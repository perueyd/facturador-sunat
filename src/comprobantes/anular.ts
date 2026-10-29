/**
 * Anulación de un comprobante ya ACEPTADO por SUNAT.
 *   - Facturas (y sus notas de crédito) → Comunicación de Baja (RA).
 *   - Boletas (y sus notas de crédito)  → Resumen Diario (RC) con estado 3 "anulado".
 * Pasado el plazo, ya no se puede anular: se emite una nota de crédito.
 * Nunca se borra nada: queda registro de quién, cuándo y por qué.
 */
import { enTransaccion, type Db } from '../db/conexion.js';
import { ahoraLima, diasEntre } from '../fechas.js';
import { TipoComprobante, idComprobanteLegible } from '../tipos.js';
import { parametro } from './repositorio.js';

export interface SolicitudAnulacion {
  comprobanteId: string;
  motivo: string;
  usuarioId?: string;
  /** Fecha de hoy en Lima (AAAA-MM-DD). Para pruebas. */
  hoy?: string;
}

export type ResultadoAnulacion =
  | { resultado: 'SOLICITADA'; via: 'BAJA' | 'RESUMEN_DIARIO'; documentoId: string; identificador: string }
  | { resultado: 'ERROR'; errores: string[] };

class ErrorAnulacion extends Error {}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export async function solicitarAnulacion(db: Db, s: SolicitudAnulacion): Promise<ResultadoAnulacion> {
  const motivo = s.motivo.trim();
  if (!motivo) return { resultado: 'ERROR', errores: ['Escribe el motivo de la anulación.'] };
  if (CONTROL.test(motivo) || motivo.length > 100) {
    // ⚠️ Longitud máxima del motivo por confirmar con la guía de SUNAT.
    return { resultado: 'ERROR', errores: ['El motivo debe tener como máximo 100 caracteres visibles.'] };
  }
  const hoy = s.hoy ?? ahoraLima().fecha;

  try {
    return await enTransaccion(db, async (tx) => {
      const r = await tx.query(
        `SELECT c.id, c.empresa_id, c.tipo_comprobante, c.serie, c.numero, c.estado, c.ambiente_sunat,
                to_char(c.fecha_emision, 'YYYY-MM-DD') AS fecha, ref.tipo_comprobante AS ref_tipo
         FROM comprobantes c
         LEFT JOIN comprobantes ref ON ref.id = c.comprobante_referencia_id
         WHERE c.id = $1 FOR UPDATE OF c`,
        [s.comprobanteId],
      );
      const c = r.rows[0];
      if (!c) throw new ErrorAnulacion('El comprobante no existe.');
      const nombre = idComprobanteLegible(c.serie, Number(c.numero));
      if (c.estado !== 'ACEPTADO' && c.estado !== 'ACEPTADO_OBS') {
        throw new ErrorAnulacion(
          c.estado === 'ANULACION_EN_PROCESO' || c.estado === 'ANULADO'
            ? `${nombre} ya está ${c.estado === 'ANULADO' ? 'anulado' : 'en proceso de anulación'}.`
            : `${nombre} aún no fue aceptado por SUNAT (estado ${c.estado}); solo se anulan comprobantes aceptados.`,
        );
      }
      const plazo = (await parametro(tx, 'PLAZO_BAJA_DIAS', 'GENERAL', hoy)).toNumber();
      if (diasEntre(c.fecha, hoy) > plazo) {
        throw new ErrorAnulacion(`Pasó el plazo de ${plazo} días para anular ${nombre}. Emite una nota de crédito.`);
      }

      const esFactura =
        c.tipo_comprobante === TipoComprobante.FACTURA ||
        (c.tipo_comprobante === TipoComprobante.NOTA_CREDITO && c.ref_tipo === TipoComprobante.FACTURA);
      const via = esFactura ? 'BAJA' : 'RESUMEN_DIARIO';
      const tabla = esFactura ? 'comunicaciones_baja' : 'resumenes_diarios';
      const prefijo = esFactura ? 'RA' : 'RC';

      // Serializa por empresa para numerar sin choques los documentos del día.
      await tx.query(`SELECT 1 FROM empresas WHERE id = $1 FOR UPDATE`, [c.empresa_id]);
      const corr = await tx.query(
        `SELECT coalesce(max(correlativo), 0) + 1 AS n FROM ${tabla} WHERE empresa_id = $1 AND fecha_generacion = $2`,
        [c.empresa_id, hoy],
      );
      const correlativo = Number(corr.rows[0].n);
      const doc = await tx.query(
        `INSERT INTO ${tabla} (empresa_id, fecha_generacion, correlativo, fecha_referencia, ambiente_sunat, solicitado_por${esFactura ? '' : ', motivo'})
         VALUES ($1, $2, $3, $4, $5, $6${esFactura ? '' : ', $7'}) RETURNING id`,
        esFactura
          ? [c.empresa_id, hoy, correlativo, c.fecha, c.ambiente_sunat, s.usuarioId ?? null]
          : [c.empresa_id, hoy, correlativo, c.fecha, c.ambiente_sunat, s.usuarioId ?? null, motivo],
      );
      const documentoId = doc.rows[0].id as string;
      if (esFactura) {
        await tx.query(`INSERT INTO baja_items (baja_id, linea, comprobante_id, motivo) VALUES ($1, 1, $2, $3)`, [documentoId, c.id, motivo]);
      } else {
        await tx.query(`INSERT INTO resumen_items (resumen_id, linea, comprobante_id, condicion) VALUES ($1, 1, $2, '3')`, [documentoId, c.id]);
      }

      await tx.query(
        `UPDATE comprobantes SET estado = 'ANULACION_EN_PROCESO', estado_antes_de_anular = estado WHERE id = $1`,
        [c.id],
      );
      await tx.query(
        `INSERT INTO comprobante_eventos (comprobante_id, estado_anterior, estado_nuevo, detalle, motivo, usuario_id)
         VALUES ($1, $2, 'ANULACION_EN_PROCESO', $3, $4, $5)`,
        [c.id, c.estado, `Anulación solicitada por ${esFactura ? 'comunicación de baja' : 'resumen diario'}`, motivo, s.usuarioId ?? null],
      );
      await tx.query(
        `INSERT INTO cola_envios (empresa_id, tipo, referencia_id, fecha_limite_legal) VALUES ($1, $2, $3, $4::date + $5::int)`,
        [c.empresa_id, via, documentoId, c.fecha, plazo],
      );
      const identificador = `${prefijo}-${hoy.replaceAll('-', '')}-${correlativo}`;
      await tx.query(
        `INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, motivo, despues)
         VALUES ($1, $2, 'SOLICITAR_ANULACION', 'comprobantes', $3, $4, $5)`,
        [c.empresa_id, s.usuarioId ?? null, c.id, motivo, JSON.stringify({ comprobante: nombre, via, identificador })],
      );
      return { resultado: 'SOLICITADA' as const, via, documentoId, identificador };
    });
  } catch (e) {
    if (e instanceof ErrorAnulacion) return { resultado: 'ERROR', errores: [e.message] };
    throw e;
  }
}
