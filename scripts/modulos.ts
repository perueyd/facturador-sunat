/**
 * Funciones del panel por empresa: cada negocio activa solo lo que usa.
 *
 *   npm run empresa:modulos -- --ruc 20XXXXXXXXX                       (muestra el estado)
 *   npm run empresa:modulos -- --ruc 20XXXXXXXXX --desactivar exportar,cobros
 *   npm run empresa:modulos -- --ruc 20XXXXXXXXX --activar exportar
 *   npm run empresa:modulos -- --ruc 20XXXXXXXXX --buen-contribuyente si
 *
 * Funciones: panel (todo el panel web), vencimientos, resumen, certificado, cobros,
 * notas (notas de crédito y anulaciones), productos, exportar.
 * Buen contribuyente: usa la columna "Buenos Contribuyentes y UESP" del cronograma.
 */
import { parseArgs } from 'node:util';
import { crearPool } from '../src/db/conexion.js';
import { MODULOS, type Modulo } from '../src/reportes/tablero.js';
import { empresaPorRuc } from './lib/consola.js';

const { values: v } = parseArgs({
  options: { ruc: { type: 'string' }, activar: { type: 'string' }, desactivar: { type: 'string' }, 'buen-contribuyente': { type: 'string' } },
});

function lista(texto: string | undefined): Modulo[] {
  const nombres = (texto ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const malos = nombres.filter((n) => !MODULOS.includes(n as Modulo));
  if (malos.length) throw new Error(`No existe: ${malos.join(', ')}. Usa: ${MODULOS.join(', ')}.`);
  return nombres as Modulo[];
}

const db = crearPool();
try {
  const empresa = await empresaPorRuc(db, v.ruc);
  const activar = lista(v.activar);
  const desactivar = lista(v.desactivar);
  if (activar.length || desactivar.length) {
    await db.query(
      `UPDATE empresas SET modulos_desactivados =
         ARRAY(SELECT DISTINCT m FROM unnest(modulos_desactivados || $2::text[]) m WHERE m <> ALL($3::text[]) ORDER BY m)
       WHERE id = $1`,
      [empresa.id, desactivar, activar],
    );
  }
  const bc = v['buen-contribuyente']?.toLowerCase();
  if (bc !== undefined) {
    if (bc !== 'si' && bc !== 'no') throw new Error('Usa --buen-contribuyente si | no');
    await db.query(`UPDATE empresas SET buen_contribuyente = $2 WHERE id = $1`, [empresa.id, bc === 'si']);
  }
  const r = (await db.query(`SELECT modulos_desactivados, buen_contribuyente FROM empresas WHERE id = $1`, [empresa.id])).rows[0];
  const apagados = r.modulos_desactivados as string[];
  console.log(`${empresa.razonSocial}${r.buen_contribuyente ? ' (buen contribuyente)' : ''}`);
  for (const m of MODULOS) console.log(`  ${apagados.includes(m) ? '✘ desactivado' : '✔ activo     '}  ${m}`);
} catch (e) {
  console.error('✘', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
