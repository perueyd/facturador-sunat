/**
 * Historial de un cliente por su número de documento: comprobantes, total comprado
 * (menos notas de crédito) y saldo pendiente. Excluye rechazados y anulados.
 */
import { sqlSaldo } from '../cobros/pagos.js';
import { Decimal, dec, sumar } from '../dinero.js';
import type { Db } from '../db/conexion.js';
import { idComprobanteLegible } from '../tipos.js';

export interface HistorialCliente {
  cliente: { tipoDocumento: string; numero: string; nombre: string };
  comprobantes: { numero: string; tipo: string; fecha: string; total: string; estado: string; estadoPago: string; saldo: string }[];
  totalComprado: string;
  saldoPendiente: string;
}

export async function historialCliente(db: Db, empresaId: string, numeroDoc: string): Promise<HistorialCliente | undefined> {
  const cli = await db.query(
    `SELECT id, tipo_doc_identidad, numero_doc, nombre_razon_social FROM clientes WHERE empresa_id = $1 AND numero_doc = $2`,
    [empresaId, numeroDoc.trim()],
  );
  const c = cli.rows[0];
  if (!c) return undefined;
  const r = await db.query(
    `SELECT c.tipo_comprobante AS tipo, c.serie, c.numero, c.fecha_emision::text AS fecha, c.importe_total::text AS total,
            c.estado::text, c.estado_pago::text AS estado_pago,
            CASE WHEN c.tipo_comprobante = '07' THEN 0 ELSE ${sqlSaldo('c')} END::text AS saldo
     FROM comprobantes c
     WHERE c.empresa_id = $1 AND c.cliente_id = $2 AND c.estado NOT IN ('RECHAZADO', 'ANULADO')
     ORDER BY c.fecha_emision, c.serie, c.numero`,
    [empresaId, c.id],
  );
  const comprobantes = r.rows.map((f) => ({
    numero: idComprobanteLegible(f.serie, Number(f.numero)), tipo: f.tipo as string, fecha: f.fecha as string,
    total: dec(f.total).toFixed(2), estado: f.estado as string, estadoPago: f.estado_pago as string, saldo: dec(f.saldo).toFixed(2),
  }));
  const comprado = comprobantes.reduce((a, x) => (x.tipo === '07' ? a.minus(x.total) : a.plus(x.total)), new Decimal(0));
  return {
    cliente: { tipoDocumento: c.tipo_doc_identidad, numero: c.numero_doc, nombre: c.nombre_razon_social },
    comprobantes,
    totalComprado: comprado.toFixed(2),
    saldoPendiente: sumar(comprobantes.map((x) => dec(x.saldo))).toFixed(2),
  };
}

export interface ClienteFrecuente {
  tipoDocumento: string;
  numero: string;
  nombre: string;
  celular: string | null;
  compras: number;
  totalComprado: string;
  ultimaCompra: string;
  diasSinComprar: number;
  saldoPendiente: string;
}

/**
 * Los clientes que más compran (último año): cuántas veces, cuánto, cuándo fue la última y
 * cuánto deben. Las notas de crédito restan; rechazados y anulados no cuentan.
 */
export async function clientesFrecuentes(db: Db, empresaId: string, hoy: string): Promise<ClienteFrecuente[]> {
  const r = await db.query(
    `SELECT k.tipo_doc_identidad, k.numero_doc, k.nombre_razon_social, k.telefono,
            count(*) FILTER (WHERE c.tipo_comprobante <> '07')::int AS compras,
            sum(CASE WHEN c.tipo_comprobante = '07' THEN -c.importe_total ELSE c.importe_total END)::text AS total,
            max(c.fecha_emision)::text AS ultima, ($2::date - max(c.fecha_emision))::int AS dias,
            coalesce(sum(${sqlSaldo('c')}) FILTER (WHERE c.tipo_comprobante <> '07'), 0)::text AS saldo
       FROM clientes k JOIN comprobantes c ON c.cliente_id = k.id
      WHERE k.empresa_id = $1 AND c.estado NOT IN ('RECHAZADO', 'ANULADO') AND c.fecha_emision > $2::date - 365
      GROUP BY k.id
     HAVING count(*) FILTER (WHERE c.tipo_comprobante <> '07') > 0
      ORDER BY compras DESC, sum(c.importe_total) DESC LIMIT 50`,
    [empresaId, hoy],
  );
  return r.rows.map((f) => ({
    tipoDocumento: f.tipo_doc_identidad, numero: f.numero_doc, nombre: f.nombre_razon_social, celular: f.telefono,
    compras: f.compras, totalComprado: dec(f.total).toFixed(2), ultimaCompra: f.ultima, diasSinComprar: f.dias, saldoPendiente: dec(f.saldo).toFixed(2),
  }));
}

/**
 * Celular para WhatsApp, como lo pide wa.me: solo dígitos con código de país.
 * "987 654 321" → "51987654321". Un número de otro país se escribe con "+" y su código.
 */
export function normalizarCelular(texto: string): string | undefined {
  const t = texto.trim();
  const digitos = t.replace(/[\s\-().]/g, '');
  if (/^9\d{8}$/.test(digitos)) return `51${digitos}`;
  if (/^(\+|00)?519\d{8}$/.test(digitos)) return digitos.replace(/^(\+|00)/, '');
  if (/^(\+|00)[1-9]\d{6,14}$/.test(digitos)) return digitos.replace(/^(\+|00)/, '');
  return undefined;
}

/** Guarda (o borra, con null) el celular de un cliente. Devuelve false si el cliente no existe. */
export async function guardarCelular(db: Db, empresaId: string, cliente: { tipoDocumento: string; numero: string }, celular: string | null, usuarioId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE clientes SET telefono = $4 WHERE empresa_id = $1 AND tipo_doc_identidad = $2 AND numero_doc = $3 RETURNING id`,
    [empresaId, cliente.tipoDocumento, cliente.numero.trim(), celular],
  );
  const id = r.rows[0]?.id as string | undefined;
  if (!id) return false;
  await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'GUARDAR_CELULAR_CLIENTE', 'clientes', $3, $4)`, [
    empresaId, usuarioId, id, JSON.stringify({ celular }),
  ]);
  return true;
}
