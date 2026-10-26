/**
 * Emisión de un comprobante: valida, asigna el número y guarda TODO en una sola
 * transacción. Garantías:
 *   - Correlativo sin saltos ni duplicados: el número se toma con
 *     `UPDATE series … RETURNING`, que bloquea la fila de la serie hasta el COMMIT.
 *     Si algo falla después, el ROLLBACK devuelve el número.
 *   - Pedido repetido → se devuelve el comprobante ya emitido (no se emite otro).
 *   - Queda en la cola de envíos para la fase 4 (envío a SUNAT).
 */
import { dec, sumar, type Decimal } from '../dinero.js';
import { recalcularCobro } from '../cobros/pagos.js';
import { codigoErrorPg, enTransaccion, restriccionPg, type Db, type Tx } from '../db/conexion.js';
import { ahoraLima } from '../fechas.js';
import { TipoComprobante, idComprobanteLegible } from '../tipos.js';
import { TipoDocIdentidad } from '../validaciones/documentos.js';
import { moverStockPorComprobante, productosPorSku } from '../inventario/stock.js';
import { prepararComprobante, type SolicitudComprobante } from './preparar.js';
import { ErrorConfiguracion, cargarComprobante, cargarContexto, type ComprobanteGuardado } from './repositorio.js';

export interface PedidoEmision {
  empresaId: string;
  canalId: string;
  marcaId?: string;
  /** Id del pedido en el canal (ej. número de pedido de la tienda). Activa la protección contra duplicados. */
  pedidoExternoId?: string;
  /** Quién emite: un usuario del panel o una llave de API. */
  usuarioId?: string;
  apiLlaveId?: string;
  solicitud: SolicitudComprobante;
}

export type ResultadoEmision =
  | { resultado: 'EMITIDO'; guardado: ComprobanteGuardado }
  | { resultado: 'REPETIDO'; guardado: ComprobanteGuardado }
  | { resultado: 'ERROR_VALIDACION'; errores: string[] };

class ErrorValidacion extends Error {
  constructor(readonly errores: string[]) {
    super(errores.join(' '));
  }
}

export async function emitirComprobante(db: Db, p: PedidoEmision): Promise<ResultadoEmision> {
  if (p.pedidoExternoId !== undefined) {
    const existente = await buscarPorPedido(db, p);
    if (existente) return { resultado: 'REPETIDO', guardado: existente };
  }
  try {
    const id = await enTransaccion(db, (tx) => emitirEnTransaccion(tx, p));
    return { resultado: 'EMITIDO', guardado: await cargarComprobante(db, id) };
  } catch (e) {
    if (e instanceof ErrorValidacion) return { resultado: 'ERROR_VALIDACION', errores: e.errores };
    if (e instanceof ErrorConfiguracion) return { resultado: 'ERROR_VALIDACION', errores: [e.message] };
    // Dos solicitudes del mismo pedido al mismo tiempo: la segunda choca con el índice único,
    // su transacción se deshace (sin gastar número) y devolvemos el comprobante de la primera.
    if (codigoErrorPg(e) === '23505' && restriccionPg(e) === 'comprobantes_pedido_unico') {
      const existente = await buscarPorPedido(db, p);
      if (existente) return { resultado: 'REPETIDO', guardado: existente };
    }
    throw e;
  }
}

async function buscarPorPedido(db: Db, p: PedidoEmision): Promise<ComprobanteGuardado | undefined> {
  const r = await db.query(
    // Un comprobante RECHAZADO no cuenta: el pedido puede emitir otro (migración 013).
    `SELECT id FROM comprobantes WHERE empresa_id = $1 AND canal_id = $2 AND pedido_externo_id = $3 AND estado <> 'RECHAZADO'`,
    [p.empresaId, p.canalId, p.pedidoExternoId],
  );
  const id = r.rows[0]?.id as string | undefined;
  return id ? cargarComprobante(db, id) : undefined;
}

async function emitirEnTransaccion(tx: Tx, p: PedidoEmision): Promise<string> {
  let s = p.solicitud;

  if (s.fechaEmision > ahoraLima().fecha) {
    throw new ErrorValidacion(['La fecha de emisión no puede ser futura.']);
  }

  const canal = await tx.query(`SELECT activo FROM canales WHERE id = $1 AND empresa_id = $2`, [p.canalId, p.empresaId]);
  if (!canal.rows[0]) throw new ErrorValidacion(['El canal no existe o no pertenece a esta empresa.']);
  if (!canal.rows[0].activo) throw new ErrorValidacion(['El canal está desactivado.']);

  const ctx = await cargarContexto(tx, p.empresaId, s.fechaEmision);

  // Nota de crédito: el comprobante original debe existir y estar vigente; el cliente es el mismo.
  let referenciaId: string | undefined;
  let saldoReferencia: { nombre: string; disponible: Decimal } | undefined;
  if (s.tipo === TipoComprobante.NOTA_CREDITO && s.notaCredito) {
    const ref = s.notaCredito.referencia;
    const orig = await tx.query(
      `SELECT id, estado, importe_total, cliente_tipo_doc, cliente_numero_doc, cliente_nombre, cliente_direccion
       FROM comprobantes WHERE empresa_id = $1 AND tipo_comprobante = $2 AND serie = $3 AND numero = $4
       FOR UPDATE`, // bloquea el original para que dos notas simultáneas no superen su total
      [p.empresaId, ref.tipo, ref.serie, ref.numero],
    );
    const o = orig.rows[0];
    const nombreRef = idComprobanteLegible(ref.serie, ref.numero);
    if (!o) throw new ErrorValidacion([`No existe el comprobante ${nombreRef} que quieres modificar.`]);
    if (['RECHAZADO', 'ANULADO', 'ANULACION_EN_PROCESO'].includes(o.estado)) {
      throw new ErrorValidacion([`El comprobante ${nombreRef} está ${o.estado.toLowerCase()}; no se le puede emitir nota de crédito.`]);
    }
    referenciaId = o.id as string;
    s = {
      ...s,
      cliente: {
        tipoDoc: o.cliente_tipo_doc as TipoDocIdentidad,
        numeroDoc: o.cliente_numero_doc,
        nombre: o.cliente_nombre,
        ...(o.cliente_direccion ? { direccion: o.cliente_direccion as string } : {}),
      },
    };
    const previas = await tx.query(
      `SELECT importe_total FROM comprobantes WHERE comprobante_referencia_id = $1 AND estado NOT IN ('RECHAZADO', 'ANULADO')`,
      [referenciaId],
    );
    const yaAcreditado = sumar(previas.rows.map((f) => dec(f.importe_total as string)));
    saldoReferencia = { nombre: nombreRef, disponible: dec(o.importe_total as string).minus(yaAcreditado) };
  }

  const preparado = prepararComprobante(s, ctx);
  if (!preparado.ok) throw new ErrorValidacion(preparado.errores);
  const c = preparado.comprobante;
  if (saldoReferencia && c.totales.importeTotal.gt(saldoReferencia.disponible)) {
    throw new ErrorValidacion([
      `La nota de crédito (S/ ${c.totales.importeTotal.toFixed(2)}) supera el saldo del comprobante ${saldoReferencia.nombre} (S/ ${saldoReferencia.disponible.toFixed(2)}).`,
    ]);
  }

  // Tomar el siguiente número (bloquea la serie hasta el COMMIT).
  const serie = await tx.query(
    `UPDATE series SET ultimo_numero = ultimo_numero + 1
     WHERE empresa_id = $1 AND tipo_comprobante = $2 AND serie = $3 AND activa
     RETURNING id, ultimo_numero`,
    [p.empresaId, c.tipo, c.serie],
  );
  const filaSerie = serie.rows[0];
  if (!filaSerie) throw new ErrorValidacion([`La serie ${c.serie} no existe o está desactivada para este tipo de comprobante.`]);
  const numero = Number(filaSerie.ultimo_numero);

  // Cliente identificado: se registra (o actualiza) para su historial de compras.
  let clienteId: string | null = null;
  if (c.cliente.tipoDoc !== TipoDocIdentidad.SIN_DOCUMENTO && c.cliente.numeroDoc.trim() && c.cliente.numeroDoc !== '-') {
    const cli = await tx.query(
      `INSERT INTO clientes (empresa_id, tipo_doc_identidad, numero_doc, nombre_razon_social, direccion) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (empresa_id, tipo_doc_identidad, numero_doc)
       DO UPDATE SET nombre_razon_social = EXCLUDED.nombre_razon_social, direccion = coalesce(EXCLUDED.direccion, clientes.direccion)
       RETURNING id`,
      [p.empresaId, c.cliente.tipoDoc, c.cliente.numeroDoc, c.cliente.nombre, c.cliente.direccion ?? null],
    );
    clienteId = cli.rows[0].id as string;
  }

  const ins = await tx.query(
    `INSERT INTO comprobantes (
       empresa_id, serie_id, tipo_comprobante, serie, numero, fecha_emision, hora_emision, moneda,
       cliente_id, cliente_tipo_doc, cliente_numero_doc, cliente_nombre, cliente_direccion,
       marca_id, canal_id, pedido_externo_id, forma_pago,
       total_gravado, total_exonerado, total_inafecto, total_igv, importe_total, parametros_usados,
       comprobante_referencia_id, motivo_nota_codigo, motivo_nota_texto,
       ambiente_sunat, emitido_por_usuario, emitido_por_llave, descuento_global, descuento_global_base)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
     RETURNING id`,
    [
      p.empresaId, filaSerie.id, c.tipo, c.serie, numero, c.fechaEmision, c.horaEmision, c.moneda,
      clienteId, c.cliente.tipoDoc, c.cliente.numeroDoc, c.cliente.nombre, c.cliente.direccion ?? null,
      p.marcaId ?? null, p.canalId, p.pedidoExternoId ?? null, c.formaPago.tipo,
      c.totales.gravado.toFixed(2), c.totales.exonerado.toFixed(2), c.totales.inafecto.toFixed(2),
      c.totales.igv.toFixed(2), c.totales.importeTotal.toFixed(2),
      JSON.stringify({
        igvTasa: ctx.parametros.igvTasa.toString(),
        montoBoletaIdentificar: ctx.parametros.montoBoletaIdentificar.toString(),
        regimen: ctx.empresa.regimen,
      }),
      referenciaId ?? null, c.notaCredito?.motivoCodigo ?? null, c.notaCredito?.motivoDescripcion ?? null,
      ctx.ambiente, p.usuarioId ?? null, p.apiLlaveId ?? null,
      c.totales.descuentoGlobal?.monto.toFixed(2) ?? '0', c.totales.descuentoGlobal?.base.toFixed(2) ?? null,
    ],
  );
  const id = ins.rows[0].id as string;

  // Cada ítem con código (SKU) se enlaza a su producto: guarda el costo del momento (para el
  // margen) y mueve el stock.
  const productos = await productosPorSku(tx, p.empresaId, c.items.flatMap((i) => (i.codigo ? [i.codigo] : [])));
  const productoDe = (codigo?: string) => (codigo ? productos.get(codigo.toUpperCase()) : undefined);
  for (const [i, item] of c.items.entries()) {
    const producto = productoDe(item.codigo);
    await tx.query(
      `INSERT INTO comprobante_items (comprobante_id, orden, producto_id, codigo, descripcion, unidad_medida, cantidad,
         precio_unitario_con_igv, valor_unitario_sin_igv, tipo_afectacion_igv, porcentaje_igv, valor_venta, igv, total, costo_unitario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, i + 1, producto?.id ?? null, item.codigo ?? null, item.descripcion, item.unidad, item.cantidad.toString(),
        item.precioUnitario.toString(), item.valorUnitario.toString(), item.afectacion,
        item.porcentajeIgv.toFixed(2), item.valorVenta.toFixed(2), item.igv.toFixed(2), item.total.toFixed(2),
        producto?.costoPromedio ?? null,
      ],
    );
  }
  await moverStockPorComprobante(tx, {
    empresaId: p.empresaId, comprobanteId: id, tipoComprobante: c.tipo,
    ...(c.notaCredito ? { motivoNota: c.notaCredito.motivoCodigo } : {}),
    items: c.items.map((item) => {
      const producto = productoDe(item.codigo);
      return { cantidad: item.cantidad, ...(producto ? { producto } : {}) };
    }),
  });

  if (c.formaPago.tipo === 'CREDITO') {
    for (const [i, cuota] of c.formaPago.cuotas.entries()) {
      await tx.query(
        `INSERT INTO comprobante_cuotas (comprobante_id, numero_cuota, monto, fecha_vencimiento) VALUES ($1,$2,$3,$4)`,
        [id, i + 1, dec(cuota.monto).toFixed(2), cuota.fechaVencimiento],
      );
    }
  }

  await tx.query(
    `INSERT INTO comprobante_eventos (comprobante_id, estado_nuevo, detalle, usuario_id, api_llave_id)
     VALUES ($1, 'EMITIDO_LOCAL', $2, $3, $4)`,
    [id, `Emitido ${idComprobanteLegible(c.serie, numero)}`, p.usuarioId ?? null, p.apiLlaveId ?? null],
  );

  // Una nota de crédito reduce lo que debe el cliente del comprobante original.
  if (referenciaId) await recalcularCobro(tx, referenciaId);

  // ⚠️ El plazo legal exacto se confirmará en la fase 4; por ahora 3 días calendario para facturas.
  await tx.query(
    `INSERT INTO cola_envios (empresa_id, tipo, referencia_id, fecha_limite_legal)
     VALUES ($1, 'COMPROBANTE', $2, $3::date + 3)`,
    [p.empresaId, id, c.fechaEmision],
  );

  await tx.query(
    `INSERT INTO auditoria (empresa_id, usuario_id, api_llave_id, accion, entidad, entidad_id, despues)
     VALUES ($1, $2, $3, 'EMITIR', 'comprobantes', $4, $5)`,
    [
      p.empresaId, p.usuarioId ?? null, p.apiLlaveId ?? null, id,
      JSON.stringify({ comprobante: idComprobanteLegible(c.serie, numero), total: c.totales.importeTotal.toFixed(2), canal: p.canalId, pedido: p.pedidoExternoId ?? null }),
    ],
  );

  return id;
}
