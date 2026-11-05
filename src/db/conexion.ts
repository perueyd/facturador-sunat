/**
 * Conexión a PostgreSQL y ayuda para transacciones.
 * La URL de conexión viene SOLO de variables de entorno (nunca en el código).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/**
 * Marca si el código corre DENTRO de una transacción. Ahí todo debe ir por `tx`:
 * si se pide otra conexión a la base (`db.query`, `enTransaccion`, el almacén sin `tx`)
 * mientras se tiene una abierta, con 10 envíos a la vez las 10 conexiones quedan
 * esperándose entre sí y el servidor se cuelga para siempre (pasó en la prueba de carga
 * del 05/11/2026, con 200 personas a la vez).
 */
const enUnaTransaccion = new AsyncLocalStorage<true>();

/** Avisa si se pide una conexión nueva teniendo una transacción abierta (en las pruebas, falla). */
export function exigirFueraDeTransaccion(que: string): void {
  if (!enUnaTransaccion.getStore()) return;
  const mensaje = `${que} dentro de una transacción: usa "tx" (otra conexión puede colgar el servidor).`;
  if (process.env.VITEST) throw new Error(mensaje);
  console.error(mensaje, new Error().stack);
}

export function crearPool(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('Falta la variable de entorno DATABASE_URL.');
  // NUMERIC llega como texto (pg no lo convierte a number): así no se pierden decimales.
  // Con DATABASE_CA_CERT (el certificado que entrega Supabase) la conexión va cifrada y
  // verificando al servidor: nadie en el camino puede hacerse pasar por la base.
  const ca = process.env.DATABASE_CA_CERT;
  const pool = new pg.Pool({ connectionString: url, max: 10, ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}) });
  // Sin este manejador, una conexión inactiva que se corta tumbaría todo el proceso.
  pool.on('error', (e) => console.error('Conexión a PostgreSQL perdida:', e.message));
  const consultar = pool.query.bind(pool);
  const conectar = pool.connect.bind(pool);
  pool.query = ((...a: Parameters<typeof consultar>) => {
    exigirFueraDeTransaccion('db.query');
    return consultar(...a);
  }) as typeof pool.query;
  pool.connect = ((...a: Parameters<typeof conectar>) => {
    exigirFueraDeTransaccion('Una transacción');
    return conectar(...a);
  }) as typeof pool.connect;
  return pool;
}

/**
 * Ejecuta `fn` dentro de una transacción. Si `fn` lanza un error, se deshace
 * TODO (incluido el número de serie que se hubiera tomado).
 */
export async function enTransaccion<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const resultado = await enUnaTransaccion.run(true, () => fn(tx));
    await tx.query('COMMIT');
    return resultado;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}

/** Código de error de PostgreSQL (ej. '23505' = valor duplicado). */
export function codigoErrorPg(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

export function restriccionPg(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'constraint' in e
    ? String((e as { constraint: unknown }).constraint)
    : undefined;
}
