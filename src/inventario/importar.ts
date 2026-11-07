/**
 * Importar productos de una vez, sin escribirlos uno por uno:
 *   - desde la tienda web (el catálogo público que ya leen Facebook/Instagram y Google:
 *     columnas id, title, price — ej. https://eydperu.vercel.app/api/feed?formato=csv), o
 *   - desde un Excel guardado como CSV con columnas código, nombre, precio.
 * Si el producto ya existe (mismo código) se actualizan su nombre y precio; lo demás
 * (stock, código de barras, si controla stock) se conserva. Los nuevos no controlan stock:
 * son productos a pedido; si alguno sí, se cambia en Stock.
 */
import { isIP } from 'node:net';
import type { Db } from '../db/conexion.js';
import { enTransaccion } from '../db/conexion.js';
import { normalizarSku } from './productos.js';

const MAXIMO_BYTES = 2 * 1024 * 1024;
const MAXIMO_FILAS = 3000;

export class ErrorImportar extends Error {}

export interface ProductoImportado { sku: string; nombre: string; precio: string }

/** Separa una línea CSV respetando las comillas ("a, b" es una sola celda). */
function celdas(linea: string, sep: string): string[] {
  const r: string[] = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i]!;
    if (comillas) {
      if (ch === '"' && linea[i + 1] === '"') { actual += '"'; i++; } else if (ch === '"') comillas = false; else actual += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) { r.push(actual); actual = ''; } else actual += ch;
  }
  r.push(actual);
  return r.map((x) => x.trim());
}

/** Divide en líneas sin cortar una celda entre comillas que tenga saltos de línea. */
function lineas(texto: string): string[] {
  const r: string[] = [];
  let actual = '';
  let comillas = false;
  for (const ch of texto.replace(/^﻿/, '')) {
    if (ch === '"') comillas = !comillas;
    if ((ch === '\n' || ch === '\r') && !comillas) { if (actual.trim()) r.push(actual); actual = ''; } else actual += ch;
  }
  if (actual.trim()) r.push(actual);
  return r;
}

const sinTildes = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Lee el CSV (de la tienda o de Excel, con coma o punto y coma) y devuelve los productos válidos y los errores por fila. */
export function leerCatalogo(texto: string): { productos: ProductoImportado[]; errores: string[] } {
  const filas = lineas(texto);
  if (filas.length < 2) throw new ErrorImportar('El archivo no tiene productos (falta la fila de títulos o los datos).');
  const sep = (filas[0]!.match(/;/g)?.length ?? 0) > (filas[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const titulos = celdas(filas[0]!, sep).map(sinTildes);
  const columna = (...nombres: string[]) => titulos.findIndex((t) => nombres.includes(t));
  const cSku = columna('id', 'sku', 'codigo');
  const cNombre = columna('title', 'nombre', 'descripcion', 'producto');
  const cPrecio = columna('price', 'precio', 'precio con igv');
  if (cSku < 0 || cNombre < 0 || cPrecio < 0) {
    throw new ErrorImportar('El archivo necesita las columnas: código (o id), nombre (o title) y precio (o price).');
  }
  const productos = new Map<string, ProductoImportado>();
  const errores: string[] = [];
  for (const [i, fila] of filas.slice(1, MAXIMO_FILAS + 1).entries()) {
    const c = celdas(fila, sep);
    const sku = normalizarSku((c[cSku] ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40));
    const nombre = (c[cNombre] ?? '').replace(/\s+/g, ' ').slice(0, 250);
    // "220.00 PEN" (tienda) o "220,50" (Excel en español).
    let precio = (c[cPrecio] ?? '').replace(/\s*(PEN|S\/\.?)\s*/gi, '');
    if (sep === ';') precio = precio.replace(',', '.');
    if (!sku || !nombre || !/^\d{1,9}(\.\d{1,2})?$/.test(precio)) {
      errores.push(`Fila ${i + 2}: falta el código, el nombre o un precio válido.`);
      continue;
    }
    productos.set(sku, { sku, nombre, precio });
  }
  if (filas.length - 1 > MAXIMO_FILAS) errores.push(`Solo se leen las primeras ${MAXIMO_FILAS} filas.`);
  return { productos: [...productos.values()], errores };
}

/**
 * Descarga el catálogo de una dirección PÚBLICA https. No acepta direcciones internas
 * (localhost, IP, redes privadas) ni redirecciones: el servidor no debe poder usarse para
 * leer cosas de su propia red.
 */
export async function descargarCatalogo(direccion: string, buscar: typeof fetch = fetch): Promise<string> {
  let url: URL;
  try { url = new URL(direccion.trim()); } catch { throw new ErrorImportar('La dirección no es válida. Ejemplo: https://eydperu.vercel.app/api/feed?formato=csv'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal)$/i.test(host) || url.username || url.port) {
    throw new ErrorImportar('Usa la dirección pública (https://…) del catálogo de tu tienda.');
  }
  let r: Response;
  try {
    r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'text/csv,text/plain' } });
  } catch {
    throw new ErrorImportar('No se pudo leer esa dirección (no responde o redirige a otra). Revisa que abra en el navegador.');
  }
  if (!r.ok) throw new ErrorImportar(`La tienda respondió con error ${r.status}.`);
  if (Number(r.headers.get('content-length') ?? 0) > MAXIMO_BYTES) throw new ErrorImportar('El catálogo es demasiado grande (máximo 2 MB).');
  const texto = await r.text();
  if (Buffer.byteLength(texto) > MAXIMO_BYTES) throw new ErrorImportar('El catálogo es demasiado grande (máximo 2 MB).');
  return texto;
}

/** Guarda los productos (crea los nuevos, actualiza nombre y precio de los que ya existen). */
export async function importarProductos(
  db: Db,
  empresaId: string,
  productos: ProductoImportado[],
  usuarioId?: string,
): Promise<{ nuevos: number; actualizados: number }> {
  if (!productos.length) throw new ErrorImportar('No hay productos válidos para importar.');
  return enTransaccion(db, async (tx) => {
    const r = await tx.query(
      `INSERT INTO productos (empresa_id, sku, nombre, precio_con_igv, controla_stock)
       SELECT $1, x.sku, x.nombre, x.precio::numeric, false FROM unnest($2::text[], $3::text[], $4::text[]) AS x(sku, nombre, precio)
       ON CONFLICT (empresa_id, sku) DO UPDATE SET nombre = EXCLUDED.nombre, precio_con_igv = EXCLUDED.precio_con_igv, activo = true
       RETURNING (xmax = 0) AS nuevo`,
      [empresaId, productos.map((p) => p.sku), productos.map((p) => p.nombre), productos.map((p) => p.precio)],
    );
    const nuevos = r.rows.filter((f) => f.nuevo).length;
    await tx.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'IMPORTAR_PRODUCTOS', 'empresas', $1, $3)`, [
      empresaId, usuarioId ?? null, JSON.stringify({ nuevos, actualizados: r.rowCount! - nuevos }),
    ]);
    return { nuevos, actualizados: r.rowCount! - nuevos };
  });
}
