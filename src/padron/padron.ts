/**
 * Padrón de SUNAT (empresas, RUC 20): razón social, estado y condición (ver migración 041).
 *
 * El archivo de SUNAT trae una línea por RUC: RUC|NOMBRE|ESTADO|CONDICIÓN|UBIGEO|…
 * Se guardan solo los RUC 20 que no están de baja (los demás no se pueden usar para facturar).
 * La carga es "por diferencias": solo se reescriben los que cambiaron y se quitan los que ya
 * no están, así la base no crece día a día con copias.
 */
import type { Db } from '../db/conexion.js';

export interface FilaPadron {
  ruc: string;
  nombre: string;
  estado: string;
  condicion: string;
}

/** Una línea del archivo de SUNAT, o undefined si no se guarda (persona, de baja, línea rara). */
export function leerLineaPadron(linea: string): FilaPadron | undefined {
  const c = linea.split('|');
  const ruc = c[0]?.trim() ?? '';
  if (!/^20\d{9}$/.test(ruc)) return undefined; // solo empresas (y no la fila de títulos)
  const estado = (c[2] ?? '').trim().replace(/\s+/g, ' ');
  if (!estado || /^(BAJA|ANUL)/.test(estado)) return undefined;
  const nombre = (c[1] ?? '').trim().replace(/\s+/g, ' ');
  if (!nombre) return undefined;
  return { ruc, nombre, estado, condicion: (c[3] ?? '').trim().replace(/\s+/g, ' ') || '-' };
}

export interface ResultadoCarga {
  filas: number;
  cambios: number;
  quitados: number;
}

const LOTE = 10_000;

/**
 * Carga el padrón del día. Usa UNA conexión: las filas pasan por una tabla temporal y al
 * final se aplican solo las diferencias, todo en una transacción (si algo falla, queda el
 * padrón de ayer completo).
 */
export async function cargarPadron(
  db: Db,
  filas: AsyncIterable<FilaPadron>,
  opciones: { archivoDel?: Date; minimo?: number } = {},
): Promise<ResultadoCarga> {
  // SUNAT tiene ~1 millón de empresas activas: un archivo con muchas menos está cortado.
  const minimo = opciones.minimo ?? 100_000;
  const cx = await db.connect();
  try {
    await cx.query('BEGIN');
    await cx.query(`CREATE TEMP TABLE padron_hoy (ruc bigint PRIMARY KEY, nombre text NOT NULL, estado text NOT NULL, condicion text NOT NULL) ON COMMIT DROP`);
    let lote: FilaPadron[] = [];
    let filasLeidas = 0;
    const subir = async () => {
      if (!lote.length) return;
      await cx.query(
        `INSERT INTO padron_hoy SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) ON CONFLICT (ruc) DO NOTHING`,
        [lote.map((f) => f.ruc), lote.map((f) => f.nombre), lote.map((f) => f.estado), lote.map((f) => f.condicion)],
      );
      filasLeidas += lote.length;
      lote = [];
    };
    for await (const f of filas) {
      lote.push(f);
      if (lote.length >= LOTE) await subir();
    }
    await subir();
    // Un archivo cortado o vacío no puede borrar el padrón bueno de ayer.
    if (filasLeidas < minimo) throw new Error(`El archivo de SUNAT trae muy pocas empresas (${filasLeidas}): no se carga.`);

    await cx.query(`INSERT INTO padron.textos (texto) SELECT DISTINCT estado FROM padron_hoy UNION SELECT DISTINCT condicion FROM padron_hoy ON CONFLICT (texto) DO NOTHING`);
    const cambios = await cx.query(
      `INSERT INTO padron.ruc (ruc, nombre, estado, condicion)
       SELECT h.ruc, h.nombre, e.id, k.id FROM padron_hoy h JOIN padron.textos e ON e.texto = h.estado JOIN padron.textos k ON k.texto = h.condicion
       ON CONFLICT (ruc) DO UPDATE SET nombre = EXCLUDED.nombre, estado = EXCLUDED.estado, condicion = EXCLUDED.condicion
       WHERE (padron.ruc.nombre, padron.ruc.estado, padron.ruc.condicion) IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.estado, EXCLUDED.condicion)`,
    );
    const quitados = await cx.query(`DELETE FROM padron.ruc p WHERE NOT EXISTS (SELECT 1 FROM padron_hoy h WHERE h.ruc = p.ruc)`);
    const r = { filas: filasLeidas, cambios: cambios.rowCount ?? 0, quitados: quitados.rowCount ?? 0 };
    await cx.query(`INSERT INTO padron.cargas (archivo_del, filas, cambios, quitados) VALUES ($1, $2, $3, $4)`, [opciones.archivoDel ?? null, r.filas, r.cambios, r.quitados]);
    await cx.query('COMMIT');
    return r;
  } catch (e) {
    await cx.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    cx.release();
  }
}

export interface RucSunat {
  nombre: string;
  estado: string;
  condicion: string;
  /** Fecha del archivo de SUNAT con que se cargó (AAAA-MM-DD). */
  al: string | null;
}

/**
 * Lo que dice SUNAT de un RUC 20. `undefined` = no figura entre las empresas activas (está de
 * baja o no existe). `null` = el padrón aún no se cargó (no se sabe nada).
 */
export async function buscarRuc(db: Db, ruc: string): Promise<RucSunat | undefined | null> {
  if (!/^20\d{9}$/.test(ruc)) return null;
  const r = await db.query(
    `SELECT p.nombre, e.texto AS estado, k.texto AS condicion,
            (SELECT to_char(coalesce(archivo_del, cargado_en) AT TIME ZONE 'America/Lima', 'YYYY-MM-DD') FROM padron.cargas ORDER BY id DESC LIMIT 1) AS al
       FROM (SELECT 1) uno
       LEFT JOIN padron.ruc p ON p.ruc = $1::bigint
       LEFT JOIN padron.textos e ON e.id = p.estado LEFT JOIN padron.textos k ON k.id = p.condicion`,
    [ruc],
  );
  const f = r.rows[0];
  if (!f.al) return null;
  return f.nombre ? { nombre: f.nombre, estado: f.estado, condicion: f.condicion, al: f.al } : undefined;
}
