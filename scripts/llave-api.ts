/**
 * Llaves de API por canal.
 *
 *   npm run llave-api -- crear   --ruc 20XXXXXXXXX --canal "Tienda web" [--permisos emitir,consultar]
 *   npm run llave-api -- listar  --ruc 20XXXXXXXXX
 *   npm run llave-api -- revocar --ruc 20XXXXXXXXX --prefijo 0a1b2c3d4e5f
 *
 * La llave completa se muestra UNA sola vez: cópiala directo a las variables de entorno
 * de la tienda (Vercel). Nunca la pegues en el código ni en GitHub.
 */
import { parseArgs } from 'node:util';
import { PERMISOS, crearLlaveApi, revocarLlave, type Permiso } from '../src/api/llaves.js';
import { crearPool } from '../src/db/conexion.js';
import { empresaPorRuc } from './lib/consola.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { ruc: { type: 'string' }, canal: { type: 'string' }, permisos: { type: 'string' }, prefijo: { type: 'string' } },
});
const accion = positionals[0];
if (!values.ruc || !['crear', 'listar', 'revocar'].includes(accion ?? '')) {
  console.error('Uso: ver el encabezado de scripts/llave-api.ts');
  process.exit(1);
}

const db = crearPool();
try {
  const { id: empresaId } = await empresaPorRuc(db, values.ruc);

  if (accion === 'crear') {
    const canal = await db.query(`SELECT id FROM canales WHERE empresa_id = $1 AND nombre = $2`, [empresaId, values.canal ?? '']);
    if (!canal.rows[0]) throw new Error(`No existe el canal "${values.canal}".`);
    const permisos = (values.permisos?.split(',').map((p) => p.trim()) ?? ['emitir', 'consultar']) as Permiso[];
    const r = await crearLlaveApi(db, { empresaId, canalId: canal.rows[0].id, permisos });
    console.log(`✔ Llave creada para "${values.canal}" (permisos: ${permisos.join(', ')}).`);
    console.log('  Cópiala AHORA; no se vuelve a mostrar (la línea completa, sin espacios):\n');
    // Sin sangría: al copiarla de la consola, los espacios de delante se iban con la llave
    // y la tienda recibía "Llave de API inválida".
    console.log(`${r.llave}\n`);
  } else if (accion === 'listar') {
    const r = await db.query(
      `SELECT l.prefijo, c.nombre AS canal, l.permisos, l.ultimo_uso_en, l.revocada_en FROM api_llaves l JOIN canales c ON c.id = l.canal_id WHERE l.empresa_id = $1 ORDER BY l.creado_en`,
      [empresaId],
    );
    console.table(r.rows.map((x) => ({ prefijo: x.prefijo, canal: x.canal, permisos: (x.permisos as string[]).join(','), ultimoUso: x.ultimo_uso_en ?? '-', estado: x.revocada_en ? 'REVOCADA' : 'ACTIVA' })));
    console.log(`Permisos posibles: ${PERMISOS.join(', ')}`);
  } else {
    const ok = await revocarLlave(db, empresaId, values.prefijo ?? '');
    console.log(ok ? '✔ Llave revocada: deja de funcionar de inmediato.' : '✘ No se encontró una llave activa con ese prefijo.');
  }
} catch (e) {
  console.error('✘', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.end();
}
