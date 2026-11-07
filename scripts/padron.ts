/**
 * Carga el padrón de SUNAT (empresas, RUC 20) en la base. Lo corre cada día
 * .github/workflows/padron.yml:
 *
 *   curl -o padron.zip https://www2.sunat.gob.pe/padron_reducido_ruc.zip
 *   unzip -p padron.zip | DATABASE_URL=... npx tsx scripts/padron.ts [fecha-del-archivo]
 *
 * El archivo viene en latin1 (Windows), por eso se lee con ese juego de letras: así "Ñ" y las
 * tildes salen bien.
 */
import { createInterface } from 'node:readline';
import { crearPool } from '../src/db/conexion.js';
import { cargarPadron, leerLineaPadron, type FilaPadron } from '../src/padron/padron.js';

async function* filas(): AsyncIterable<FilaPadron> {
  process.stdin.setEncoding('latin1');
  for await (const linea of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const f = leerLineaPadron(linea);
    if (f) yield f;
  }
}

const db = crearPool();
const fecha = process.argv[2] ? new Date(process.argv[2]) : undefined;
const inicio = Date.now();
try {
  const r = await cargarPadron(db, filas(), fecha && !Number.isNaN(fecha.getTime()) ? { archivoDel: fecha } : {});
  console.log(`✔ Padrón cargado: ${r.filas} empresas, ${r.cambios} nuevas o cambiadas, ${r.quitados} quitadas (${Math.round((Date.now() - inicio) / 1000)} s).`);
} catch (e) {
  console.error('✖ No se pudo cargar el padrón:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
