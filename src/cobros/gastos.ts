/**
 * Gastos y caja chica: el dinero que SALE y de qué cuenta salió.
 *
 * Con esto el cierre de caja compara lo contado con (cobros − gastos) de cada cuenta. Las
 * compras de mercadería con factura van además en Compras (IGV y stock); aquí solo se controla
 * el dinero. Un gasto no se cambia ni se borra: se anula con motivo. Montos exactos (NUMERIC).
 */
import { createHash } from 'node:crypto';
import type { Almacen } from '../almacen/almacen.js';
import { enTransaccion, type Db } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { esFecha } from '../fechas.js';
import { tipoImagen } from '../empresas/logo.js';
import { MEDIOS_PAGO, type MedioPago } from './pagos.js';

export class ErrorGasto extends Error {}

export const CATEGORIAS_GASTO = {
  MERCADERIA: 'Mercadería',
  INSUMOS: 'Insumos y materiales',
  ALQUILER: 'Alquiler',
  SERVICIOS: 'Luz, agua, internet',
  SUELDOS: 'Sueldos y pagos a personal',
  TRANSPORTE: 'Transporte y delivery',
  MANTENIMIENTO: 'Mantenimiento y reparaciones',
  PUBLICIDAD: 'Publicidad',
  IMPUESTOS: 'Impuestos y trámites',
  OTROS: 'Otros',
} as const;
export type CategoriaGasto = keyof typeof CATEGORIAS_GASTO;

export interface Gasto {
  id: string;
  fecha: string;
  monto: string;
  categoria: CategoriaGasto;
  descripcion: string;
  medio: string;
  cuenta: string | null;
  documento: string | null;
  /** Tiene foto del recibo. */
  foto: boolean;
  registradoPor: string;
  anulado: { motivo: string; por: string } | null;
}

export async function registrarGasto(
  db: Db,
  empresaId: string,
  g: { fecha: string; monto: string; categoria: string; descripcion: string; medio: string; cuentaId?: string; documento?: string },
  usuarioId: string,
  hoy: string,
): Promise<string> {
  if (!esFecha(g.fecha) || g.fecha > hoy) throw new ErrorGasto('La fecha del gasto debe ser de hoy hacia atrás.');
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(g.monto) || !dec(g.monto).gt(0)) throw new ErrorGasto('Escribe el monto, por ejemplo 25.50.');
  if (!(g.categoria in CATEGORIAS_GASTO)) throw new ErrorGasto('Elige una categoría.');
  const descripcion = g.descripcion.trim();
  if (!descripcion || descripcion.length > 200) throw new ErrorGasto('Escribe en qué se gastó, por ejemplo "Pasaje a Gamarra".');
  if (!MEDIOS_PAGO.includes(g.medio as MedioPago)) throw new ErrorGasto('Elige de dónde salió el dinero.');
  if (g.cuentaId) {
    const cuenta = (await db.query(`SELECT medio::text AS medio FROM cuentas_cobro WHERE id = $1 AND empresa_id = $2 AND activa`, [g.cuentaId, empresaId])).rows[0];
    if (!cuenta) throw new ErrorGasto('Esa cuenta no existe o está desactivada.');
    if (cuenta.medio !== g.medio) throw new ErrorGasto(`Esa cuenta es de ${cuenta.medio}, no de ${g.medio}.`);
  }
  const r = await db.query(
    `INSERT INTO gastos (empresa_id, fecha, monto, categoria, descripcion, medio, cuenta_id, documento, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [empresaId, g.fecha, g.monto, g.categoria, descripcion, g.medio, g.cuentaId ?? null, g.documento?.trim().slice(0, 60) || null, usuarioId],
  );
  return r.rows[0].id as string;
}

export async function anularGasto(db: Db, empresaId: string, id: string, motivo: string, usuarioId: string): Promise<boolean> {
  const m = motivo.trim();
  if (m.length < 3) throw new ErrorGasto('Escribe por qué se anula el gasto.');
  const r = await db.query(
    `UPDATE gastos SET anulado_en = now(), anulado_por = $3, motivo_anulacion = $4 WHERE id = $1 AND empresa_id = $2 AND anulado_en IS NULL RETURNING id`,
    [id, empresaId, usuarioId, m.slice(0, 200)],
  );
  if (r.rowCount) {
    await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, motivo) VALUES ($1, $2, 'ANULAR_GASTO', 'gastos', $3, $4)`, [empresaId, usuarioId, id, m]);
  }
  return Boolean(r.rowCount);
}

/** Gastos de un período (incluye los anulados, marcados) y el total por categoría. */
export async function gastosDelPeriodo(db: Db, empresaId: string, desde: string, hasta: string): Promise<{ gastos: Gasto[]; total: string; porCategoria: { categoria: CategoriaGasto; nombre: string; monto: string; ancho: number }[] }> {
  const r = await db.query(
    `SELECT g.id, g.fecha::text AS fecha, g.monto::text AS monto, g.categoria, g.descripcion, g.medio::text AS medio, k.nombre AS cuenta, g.documento, g.foto_archivo_id IS NOT NULL AS foto,
            coalesce(u.nombre, u.email) AS registrado_por, g.motivo_anulacion, coalesce(a.nombre, a.email) AS anulado_por
       FROM gastos g JOIN usuarios u ON u.id = g.registrado_por
       LEFT JOIN cuentas_cobro k ON k.id = g.cuenta_id LEFT JOIN usuarios a ON a.id = g.anulado_por
      WHERE g.empresa_id = $1 AND g.fecha BETWEEN $2::date AND $3::date
      ORDER BY g.fecha DESC, g.creado_en DESC LIMIT 500`,
    [empresaId, desde, hasta],
  );
  const gastos = r.rows.map((f): Gasto => ({
    id: f.id, fecha: f.fecha, monto: dec(f.monto).toFixed(2), categoria: f.categoria, descripcion: f.descripcion, medio: f.medio,
    cuenta: f.cuenta, documento: f.documento, foto: f.foto, registradoPor: f.registrado_por,
    anulado: f.motivo_anulacion ? { motivo: f.motivo_anulacion, por: f.anulado_por } : null,
  }));
  const sumas = new Map<CategoriaGasto, ReturnType<typeof dec>>();
  for (const g of gastos) if (!g.anulado) sumas.set(g.categoria, (sumas.get(g.categoria) ?? dec('0')).plus(g.monto));
  const orden = [...sumas].sort((a, b) => b[1].comparedTo(a[1]));
  const mayor = orden[0]?.[1];
  // Ancho de la barra (0 a 100) respecto de la categoría más grande; lo calcula el facturador.
  const porCategoria = orden.map(([categoria, m]) => ({ categoria, nombre: CATEGORIAS_GASTO[categoria], monto: m.toFixed(2), ancho: mayor ? m.div(mayor).times(100).round().toNumber() : 0 }));
  return { gastos, total: [...sumas.values()].reduce((t, m) => t.plus(m), dec('0')).toFixed(2), porCategoria };
}

// ---------- Foto del recibo ----------

/** La foto ya llega achicada desde el navegador; este tope evita subir fotos enteras del celular. */
export const FOTO_MAXIMO_BYTES = 350 * 1024;

/** Guarda la foto del recibo de un gasto. Una sola por gasto: no se reemplaza. */
export async function guardarFotoGasto(db: Db, almacen: Almacen, empresaId: string, gastoId: string, imagen: Buffer, usuarioId: string): Promise<void> {
  const tipo = tipoImagen(imagen);
  if (!tipo) throw new ErrorGasto('La foto debe ser una imagen JPG o PNG.');
  if (imagen.length > FOTO_MAXIMO_BYTES) throw new ErrorGasto('La foto es muy pesada (máximo 350 KB).');
  const g = (await db.query(
    `SELECT g.foto_archivo_id, g.anulado_en, e.ruc FROM gastos g JOIN empresas e ON e.id = g.empresa_id WHERE g.id = $1 AND g.empresa_id = $2`,
    [gastoId, empresaId],
  )).rows[0];
  if (!g) throw new ErrorGasto('Gasto no encontrado.');
  if (g.anulado_en) throw new ErrorGasto('Ese gasto está anulado.');
  if (g.foto_archivo_id) throw new ErrorGasto('Ese gasto ya tiene su foto.');
  const sha256 = createHash('sha256').update(imagen).digest('hex');
  const ruta = `${g.ruc}/gastos/${gastoId}-${sha256.slice(0, 16)}.${tipo}`;
  await almacen.guardar(ruta, imagen);
  await enTransaccion(db, async (tx) => {
    const a = await tx.query(
      `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta)
       VALUES ($1, 'gastos', $2, 'SUSTENTO', $3, $4, $5, (current_date + interval '6 years')::date) RETURNING id`,
      [empresaId, gastoId, ruta, sha256, imagen.length],
    );
    // Solo si sigue sin foto (dos subidas a la vez: gana la primera).
    const r = await tx.query(`UPDATE gastos SET foto_archivo_id = $3 WHERE id = $1 AND empresa_id = $2 AND foto_archivo_id IS NULL RETURNING id`, [gastoId, empresaId, a.rows[0].id]);
    if (!r.rowCount) throw new ErrorGasto('Ese gasto ya tiene su foto.');
    await tx.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'FOTO_GASTO', 'gastos', $3, $4)`, [
      empresaId, usuarioId, gastoId, JSON.stringify({ archivo: a.rows[0].id, sha256 }),
    ]);
  });
}

/** La foto del recibo (o undefined si el gasto no tiene, o no es de la empresa). */
export async function fotoDeGasto(db: Db, almacen: Almacen, empresaId: string, gastoId: string): Promise<{ datos: Buffer; tipo: string } | undefined> {
  const f = (await db.query(
    `SELECT a.ruta_almacenamiento AS ruta FROM gastos g JOIN archivos a ON a.id = g.foto_archivo_id WHERE g.id = $1 AND g.empresa_id = $2`,
    [gastoId, empresaId],
  )).rows[0];
  if (!f) return undefined;
  const datos = await almacen.leer(f.ruta);
  return { datos, tipo: tipoImagen(datos) === 'png' ? 'image/png' : 'image/jpeg' };
}
