/**
 * Almacenamiento de archivos (XML firmados, CDR, PDF).
 *
 * Regla: los archivos se escriben UNA vez y nunca se sobrescriben.
 *   - `AlmacenPostgres` (producción): el contenido va en la misma base de datos
 *     (tabla `archivos_contenido`, solo inserción). Un XML firmado pesa pocos KB y
 *     así los respaldos diarios de la base cubren también los archivos.
 *   - `AlmacenLocal`: una carpeta, para desarrollo y pruebas.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { exigirFueraDeTransaccion, type Db, type Tx } from '../db/conexion.js';

/**
 * Dentro de una transacción, pasa su `tx`: el almacén de producción guarda en la base
 * y debe usar esa misma conexión (ver `exigirFueraDeTransaccion`).
 */
export interface Almacen {
  /** Guarda el archivo. Falla si ya existe un archivo distinto en esa ruta. */
  guardar(ruta: string, contenido: Buffer, tx?: Tx): Promise<void>;
  leer(ruta: string, tx?: Tx): Promise<Buffer>;
}

export class ErrorAlmacen extends Error {}

const RUTA_VALIDA = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function validarRuta(ruta: string): void {
  if (!RUTA_VALIDA.test(ruta) || ruta.split('/').some((p) => p === '..' || p === '.')) {
    throw new ErrorAlmacen(`Ruta de archivo no permitida: "${ruta}"`);
  }
}

export class AlmacenLocal implements Almacen {
  private readonly base: string;

  constructor(base: string) {
    this.base = resolve(base);
  }

  private absoluta(ruta: string): string {
    validarRuta(ruta);
    const abs = resolve(this.base, ruta);
    if (!abs.startsWith(this.base + sep)) throw new ErrorAlmacen(`Ruta fuera del almacén: "${ruta}"`);
    return abs;
  }

  async guardar(ruta: string, contenido: Buffer, tx?: Tx): Promise<void> {
    // La carpeta no usa la base, pero se exige lo mismo que en producción para que las
    // pruebas descubran un guardado sin "tx" (con la base, colgaría el servidor).
    if (!tx) exigirFueraDeTransaccion('almacen.guardar sin tx');
    const abs = this.absoluta(ruta);
    await mkdir(dirname(abs), { recursive: true });
    try {
      await writeFile(abs, contenido, { flag: 'wx' }); // wx = falla si ya existe
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Reintento tras un fallo: si el contenido es idéntico, no es un problema.
      const existente = await readFile(abs);
      if (!existente.equals(contenido)) throw new ErrorAlmacen(`Ya existe un archivo distinto en "${ruta}"; no se sobrescribe.`);
    }
  }

  async leer(ruta: string, tx?: Tx): Promise<Buffer> {
    if (!tx) exigirFueraDeTransaccion('almacen.leer sin tx');
    return readFile(this.absoluta(ruta));
  }
}

export class AlmacenPostgres implements Almacen {
  constructor(private readonly db: Db) {}

  async guardar(ruta: string, contenido: Buffer, tx?: Tx): Promise<void> {
    validarRuta(ruta);
    const q = tx ?? this.db;
    const sha256 = createHash('sha256').update(contenido).digest('hex');
    const r = await q.query(
      `INSERT INTO archivos_contenido (ruta, contenido, sha256) VALUES ($1, $2, $3) ON CONFLICT (ruta) DO NOTHING`,
      [ruta, contenido, sha256],
    );
    if (r.rowCount) return;
    // Ya existía (reintento tras un fallo): solo es válido si es el mismo contenido.
    const existente = await q.query(`SELECT sha256 FROM archivos_contenido WHERE ruta = $1`, [ruta]);
    if (existente.rows[0]?.sha256 !== sha256) throw new ErrorAlmacen(`Ya existe un archivo distinto en "${ruta}"; no se sobrescribe.`);
  }

  async leer(ruta: string, tx?: Tx): Promise<Buffer> {
    validarRuta(ruta);
    const r = await (tx ?? this.db).query(`SELECT contenido FROM archivos_contenido WHERE ruta = $1`, [ruta]);
    if (!r.rows[0]) throw new ErrorAlmacen(`No existe el archivo "${ruta}".`);
    return r.rows[0].contenido as Buffer;
  }
}
