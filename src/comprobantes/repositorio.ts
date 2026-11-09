/**
 * Lectura de datos de la base: contexto tributario de la empresa y comprobantes guardados.
 */
import { Decimal, dec } from '../dinero.js';
import type { Db, Tx } from '../db/conexion.js';
import {
  Afectacion,
  TipoComprobante,
  type Comprobante,
  type Empresa,
  type ItemCalculado,
  type Regimen,
} from '../tipos.js';
import type { TipoDocIdentidad } from '../validaciones/documentos.js';
import type { ContextoEmpresa } from './preparar.js';

type Consultor = Db | Tx;

export class ErrorConfiguracion extends Error {}

export async function cargarEmpresa(q: Consultor, empresaId: string, fecha: string): Promise<{ empresa: Empresa; ambiente: string }> {
  const r = await q.query(
    `SELECT e.*, (
        SELECT regimen FROM empresa_regimen er
        WHERE er.empresa_id = e.id AND er.vigente_desde <= $2::date
          AND (er.vigente_hasta IS NULL OR er.vigente_hasta >= $2::date)
        ORDER BY er.vigente_desde DESC LIMIT 1
      ) AS regimen
     FROM empresas e WHERE e.id = $1`,
    [empresaId, fecha],
  );
  const e = r.rows[0];
  if (!e) throw new ErrorConfiguracion('La empresa no existe.');
  if (!e.regimen) throw new ErrorConfiguracion(`La empresa no tiene un régimen tributario configurado para ${fecha}.`);
  return {
    ambiente: e.ambiente_sunat,
    empresa: {
      ruc: e.ruc,
      razonSocial: e.razon_social,
      ...(e.nombre_comercial ? { nombreComercial: e.nombre_comercial } : {}),
      regimen: e.regimen as Regimen,
      direccion: {
        ubigeo: e.ubigeo,
        departamento: e.departamento,
        provincia: e.provincia,
        distrito: e.distrito,
        direccion: e.direccion,
        codigoLocal: e.codigo_establecimiento,
        ...(e.urbanizacion ? { urbanizacion: e.urbanizacion } : {}),
      },
    },
  };
}

/** Valor vigente de un parámetro en una fecha; el específico del régimen gana al general. */
export async function parametro(q: Consultor, codigo: string, regimen: Regimen, fecha: string): Promise<Decimal> {
  const r = await q.query(
    `SELECT valor FROM parametros_tributarios
     WHERE codigo = $1 AND (regimen = $2 OR regimen IS NULL)
       AND vigente_desde <= $3::date AND (vigente_hasta IS NULL OR vigente_hasta >= $3::date)
     ORDER BY (regimen IS NULL), vigente_desde DESC LIMIT 1`,
    [codigo, regimen, fecha],
  );
  const fila = r.rows[0];
  if (!fila) throw new ErrorConfiguracion(`Falta configurar el parámetro ${codigo} vigente para ${fecha}.`);
  return dec(fila.valor as string);
}

export async function cargarContexto(q: Consultor, empresaId: string, fecha: string): Promise<ContextoEmpresa & { ambiente: string }> {
  const { empresa, ambiente } = await cargarEmpresa(q, empresaId, fecha);
  const [igvTasa, montoBoletaIdentificar] = await Promise.all([
    parametro(q, 'IGV_TASA', empresa.regimen, fecha),
    parametro(q, 'BOLETA_MONTO_IDENTIFICAR', empresa.regimen, fecha),
  ]);
  const permitidos = await q.query(
    `SELECT tipo_comprobante FROM regimen_comprobantes_permitidos WHERE regimen = $1 AND permitido`,
    [empresa.regimen],
  );
  const exoneraciones = await q.query(
    `SELECT DISTINCT x.tipo_afectacion_igv FROM empresa_exoneraciones ex
     JOIN exoneraciones x ON x.codigo = ex.exoneracion_codigo
     WHERE ex.empresa_id = $1 AND x.vigente_desde <= $2::date AND (x.vigente_hasta IS NULL OR x.vigente_hasta >= $2::date)`,
    [empresaId, fecha],
  );
  return {
    empresa,
    ambiente,
    parametros: { igvTasa, montoBoletaIdentificar },
    comprobantesPermitidos: permitidos.rows.map((f) => f.tipo_comprobante as TipoComprobante),
    afectacionesPermitidas: [
      Afectacion.GRAVADO,
      ...exoneraciones.rows.map((f) => f.tipo_afectacion_igv as Afectacion),
    ],
  };
}

export interface ComprobanteGuardado {
  id: string;
  estado: string;
  comprobante: Comprobante;
}

/** Reconstruye un comprobante guardado (para generar su XML o devolverlo a un canal). */
export async function cargarComprobante(q: Consultor, id: string): Promise<ComprobanteGuardado> {
  const r = await q.query(
    `SELECT c.*, to_char(c.fecha_emision, 'YYYY-MM-DD') AS fecha_txt, to_char(c.hora_emision, 'HH24:MI:SS') AS hora_txt,
            ref.tipo_comprobante AS ref_tipo, ref.serie AS ref_serie, ref.numero AS ref_numero
     FROM comprobantes c LEFT JOIN comprobantes ref ON ref.id = c.comprobante_referencia_id
     WHERE c.id = $1`,
    [id],
  );
  const c = r.rows[0];
  if (!c) throw new Error('Comprobante no encontrado.');
  const { empresa } = await cargarEmpresa(q, c.empresa_id, c.fecha_txt);
  const items = await q.query(`SELECT * FROM comprobante_items WHERE comprobante_id = $1 ORDER BY orden`, [id]);
  const cuotas = await q.query(
    `SELECT monto, to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha FROM comprobante_cuotas WHERE comprobante_id = $1 ORDER BY numero_cuota`,
    [id],
  );

  const itemsCalc: ItemCalculado[] = items.rows.map((i) => ({
    ...(i.codigo ? { codigo: i.codigo as string } : {}),
    descripcion: i.descripcion,
    unidad: i.unidad_medida,
    cantidad: new Decimal(i.cantidad),
    afectacion: i.tipo_afectacion_igv as Afectacion,
    precioUnitario: new Decimal(i.precio_unitario_con_igv),
    valorUnitario: new Decimal(i.valor_unitario_sin_igv),
    valorVenta: new Decimal(i.valor_venta),
    igv: new Decimal(i.igv),
    porcentajeIgv: new Decimal(i.porcentaje_igv),
    total: new Decimal(i.total),
  }));
  const gravado = new Decimal(c.total_gravado);
  const exonerado = new Decimal(c.total_exonerado);
  const inafecto = new Decimal(c.total_inafecto);
  const igv = new Decimal(c.total_igv);
  const valorVenta = gravado.plus(exonerado).plus(inafecto);

  return {
    id: c.id,
    estado: c.estado,
    comprobante: {
      tipo: c.tipo_comprobante as TipoComprobante,
      serie: c.serie,
      numero: Number(c.numero),
      fechaEmision: c.fecha_txt,
      horaEmision: c.hora_txt,
      moneda: 'PEN',
      empresa,
      cliente: {
        tipoDoc: c.cliente_tipo_doc as TipoDocIdentidad,
        numeroDoc: c.cliente_numero_doc,
        nombre: c.cliente_nombre,
        ...(c.cliente_direccion ? { direccion: c.cliente_direccion as string } : {}),
      },
      items: itemsCalc,
      totales: {
        gravado,
        exonerado,
        inafecto,
        igv,
        valorVenta,
        precioVenta: valorVenta.plus(igv),
        importeTotal: new Decimal(c.importe_total),
        ...(c.descuento_global_base !== null
          ? { descuentoGlobal: { monto: new Decimal(c.descuento_global), base: new Decimal(c.descuento_global_base) } }
          : {}),
      },
      formaPago:
        c.forma_pago === 'CREDITO'
          ? { tipo: 'CREDITO', cuotas: cuotas.rows.map((q2) => ({ monto: q2.monto as string, fechaVencimiento: q2.fecha as string })) }
          : { tipo: 'CONTADO' },
      ...(c.tipo_comprobante === TipoComprobante.NOTA_CREDITO || c.tipo_comprobante === TipoComprobante.NOTA_DEBITO
        ? {
            [c.tipo_comprobante === TipoComprobante.NOTA_CREDITO ? 'notaCredito' : 'notaDebito']: {
              referencia: { tipo: c.ref_tipo as TipoComprobante, serie: c.ref_serie, numero: Number(c.ref_numero) },
              motivoCodigo: c.motivo_nota_codigo,
              motivoDescripcion: c.motivo_nota_texto,
            },
          }
        : {}),
    },
  };
}
