/**
 * Reiniciar los datos de PRUEBA de una empresa guardando una copia (y poder restaurarla).
 *
 * Las reglas no están aquí sino en la base (migración 048): solo en ambiente BETA, nunca con
 * comprobantes de producción, y nada se quita sin copiarlo antes. Este archivo solo pregunta
 * y traduce los errores a algo que el dueño entienda.
 */
import { codigoErrorPg, type Db } from '../db/conexion.js';

export class ErrorReinicio extends Error {}

/** VENTAS va siempre; CLIENTES y COMPRAS (compras, gastos y el resto del stock) los elige el dueño. */
export const GRUPOS = ['VENTAS', 'CLIENTES', 'COMPRAS'] as const;
export type Grupo = (typeof GRUPOS)[number];

interface CopiaDeReinicio {
  id: string;
  fecha: string;
  motivo: 'REINICIO' | 'ANTES_DE_RESTAURAR';
  grupos: Grupo[];
  /** Filas guardadas por tabla. */
  filas: Record<string, number>;
  quien: string | null;
}

interface EstadoReinicio {
  /** Si no se puede, aquí va el porqué (empresa en producción, envío en curso…). */
  bloqueo: string | null;
  /** Lo que hay hoy, por grupo y tabla: es lo que se quitaría. */
  hay: Record<Grupo, Record<string, number>>;
  copias: CopiaDeReinicio[];
}

/** Errores que la base lanza a propósito con un mensaje ya escrito para el dueño. */
const CON_MENSAJE_PROPIO = new Set(['23001', 'P0002']);

export async function estadoReinicio(db: Db, empresaId: string): Promise<EstadoReinicio> {
  const bloqueo = (await db.query(`SELECT reinicio_bloqueo($1) AS motivo`, [empresaId])).rows[0].motivo as string | null;
  const hay: EstadoReinicio['hay'] = { VENTAS: {}, CLIENTES: {}, COMPRAS: {} };
  for (const f of (await db.query(`SELECT grupo, tabla, filas::int AS filas FROM reinicio_conteo($1)`, [empresaId])).rows) {
    const grupo = hay[f.grupo as Grupo];
    grupo[f.tabla as string] = (grupo[f.tabla as string] ?? 0) + (f.filas as number);
  }
  const copias = await db.query(
    `SELECT r.id, r.creado_en, r.motivo, r.grupos, r.resumen, u.nombre
       FROM reinicios r LEFT JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.empresa_id = $1 ORDER BY r.creado_en DESC, r.id`,
    [empresaId],
  );
  return {
    bloqueo, hay,
    copias: copias.rows.map((c) => ({
      id: c.id, fecha: (c.creado_en as Date).toISOString(), motivo: c.motivo, grupos: c.grupos, filas: c.resumen, quien: c.nombre ?? null,
    })),
  };
}

/** Quita lo elegido (VENTAS siempre) y devuelve el id de la copia donde quedó guardado. */
export async function reiniciar(db: Db, d: { empresaId: string; usuarioId: string; grupos: readonly Grupo[] }): Promise<string> {
  const grupos = GRUPOS.filter((g) => g === 'VENTAS' || d.grupos.includes(g));
  try {
    return (await db.query(`SELECT reiniciar_empresa($1, $2, $3::text[]) AS copia`, [d.empresaId, d.usuarioId, grupos])).rows[0].copia as string;
  } catch (e) {
    if (CON_MENSAJE_PROPIO.has(codigoErrorPg(e) ?? '')) throw new ErrorReinicio((e as Error).message);
    throw e;
  }
}

/** Devuelve una copia a su sitio. Lo que hubiera en ese momento queda en otra copia (su id es lo que devuelve). */
export async function restaurarCopia(db: Db, d: { empresaId: string; usuarioId: string; copiaId: string }): Promise<string> {
  try {
    return (await db.query(`SELECT restaurar_reinicio($1, $2, $3) AS copia`, [d.empresaId, d.usuarioId, d.copiaId])).rows[0].copia as string;
  } catch (e) {
    const codigo = codigoErrorPg(e) ?? '';
    if (CON_MENSAJE_PROPIO.has(codigo)) throw new ErrorReinicio((e as Error).message);
    // Una fila guardada ya no encaja (p. ej. apunta a un producto que se quitó después).
    // La base deshace todo: no queda nada a medias.
    if (codigo.startsWith('23') || codigo.startsWith('22') || codigo.startsWith('42')) {
      throw new ErrorReinicio('Esta copia ya no encaja con los datos de ahora (cambió algo de lo que dependía). No se cambió nada.');
    }
    throw e;
  }
}
