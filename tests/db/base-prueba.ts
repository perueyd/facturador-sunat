/**
 * Base de datos para pruebas: se reinicia desde cero y se aplican las migraciones.
 * Requiere DATABASE_URL_PRUEBAS (ver `npm run db:prueba`). Por seguridad solo
 * acepta bases cuyo nombre termine en "_pruebas".
 */
import { crearPool, type Db } from '../../src/db/conexion.js';
import { configurarEmpresa } from '../../src/empresas/configurar.js';
import { randomUUID } from 'node:crypto';
import type { crearApp } from '../../src/api/app.js';
import { activarTotp, asignarEmpresa, crearUsuario, type Rol } from '../../src/panel/usuarios.js';
import { codigoTotp, pasoActual } from '../../src/seguridad/totp.js';
import type { Regimen } from '../../src/tipos.js';
import { migrar } from '../../scripts/migrar.js';
import { RUC_EMPRESA } from '../ayudantes.js';

export const URL_PRUEBAS = process.env.DATABASE_URL_PRUEBAS;

/**
 * Deja libres todos los códigos de la app de un usuario (como si hubiera pasado un minuto).
 * Las pruebas no deben depender de en qué segundo del bloque de 30 s corren: con el truco de
 * "activar con el paso anterior", si el reloj cambiaba de bloque justo ahí, fallaban al azar.
 */
export async function liberarCodigos(db: Db, usuarioId: string): Promise<void> {
  await db.query(`UPDATE usuarios SET totp_ultimo_paso = NULL WHERE id = $1`, [usuarioId]);
}

/** Activa el segundo paso con el código de ahora y deja los códigos libres para la prueba. */
export async function activarSegundoPaso(db: Db, usuarioId: string, secreto: Buffer, llaveMaestra: Buffer): Promise<void> {
  if (!(await activarTotp(db, usuarioId, codigoTotp(secreto, pasoActual()), llaveMaestra))) throw new Error('No se activó el segundo paso.');
  await liberarCodigos(db, usuarioId);
}

export async function prepararBase(): Promise<Db> {
  if (!URL_PRUEBAS) throw new Error('Falta DATABASE_URL_PRUEBAS');
  const nombre = new URL(URL_PRUEBAS).pathname.slice(1);
  if (!nombre.endsWith('_pruebas')) {
    throw new Error(`Por seguridad, las pruebas solo corren en bases "*_pruebas" (recibí "${nombre}").`);
  }
  const db = crearPool(URL_PRUEBAS);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(db, () => undefined);
  return db;
}

export interface Fixture {
  empresaId: string;
  canalTienda: string;
  canalManual: string;
  marcaId: string;
}

/** Empresa con series F001, B001, FC01, BC01, marca y canales: la misma configuración de producción. */
export async function crearEmpresa(db: Db, ruc = RUC_EMPRESA, regimen: Regimen = 'MYPE_TRIBUTARIO'): Promise<Fixture> {
  const { empresaId } = await configurarEmpresa(db, {
    ruc, razonSocial: 'EMPRESA DE PRUEBA S.A.C.', nombreComercial: 'Espacios y Diseño',
    ubigeo: '150101', departamento: 'LIMA', provincia: 'LIMA', distrito: 'LIMA', direccion: 'AV. PRUEBA 123',
    regimen, regimenDesde: '2020-01-01', marca: 'Espacios y Diseño',
  });
  const r = await db.query(
    `SELECT (SELECT id FROM canales WHERE empresa_id = $1 AND nombre = 'Tienda web') AS tienda,
            (SELECT id FROM canales WHERE empresa_id = $1 AND nombre = 'WhatsApp') AS manual,
            (SELECT id FROM marcas WHERE empresa_id = $1) AS marca`,
    [empresaId],
  );
  return { empresaId, canalTienda: r.rows[0].tienda, canalManual: r.rows[0].manual, marcaId: r.rows[0].marca };
}

/**
 * Panel para pruebas: `entrar(rol)` crea un usuario con ese rol en la empresa, activa su
 * segundo paso y devuelve la cookie; `pedir` llama al panel como lo hace el navegador.
 */
export function panelDePrueba(app: ReturnType<typeof crearApp>, db: Db, llaveMaestra: Buffer) {
  let n = 0;
  const pedir = (ruta: string, o: { cuerpo?: unknown; cookie?: string } = {}) =>
    app.request(`http://localhost${ruta}`, {
      method: o.cuerpo !== undefined ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Panel': '1', ...(o.cookie ? { Cookie: o.cookie } : {}) },
      ...(o.cuerpo !== undefined ? { body: JSON.stringify(o.cuerpo) } : {}),
    });
  async function entrar(empresaId: string, rol: Rol): Promise<string> {
    const email = `panel${++n}-${randomUUID().slice(0, 8)}@prueba.pe`;
    const { usuarioId, secreto } = await crearUsuario(db, { email, nombre: `Usuario ${n}`, contrasena: 'clave del panel 2026', llaveMaestra });
    await asignarEmpresa(db, usuarioId, empresaId, rol);
    await activarSegundoPaso(db, usuarioId, secreto, llaveMaestra);
    const r = await pedir('/panel/api/entrar', { cuerpo: { email, contrasena: 'clave del panel 2026', codigo: codigoTotp(secreto, pasoActual()) } });
    if (r.status !== 200) throw new Error(`No se pudo entrar al panel (${r.status}).`);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  return { entrar, pedir };
}
