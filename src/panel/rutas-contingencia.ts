/**
 * Rutas del panel · Vender sin internet (boletas impresas de contingencia).
 * El celular manda aquí las ventas que anotó sin señal; el dueño o el contador
 * descargan el archivo para informarlas a SUNAT dentro de los 7 días.
 */
import type { Hono } from 'hono';
import { ErrorContingencia, diasDeContingencia, generarInforme, registrarContingencia } from '../contingencia/contingencia.js';
import { esFecha } from '../fechas.js';
import { ROLES_EMISORES } from './usuarios.js';
import { ROLES_COMPRAS } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';

export function registrarRutasContingencia(app: Hono<any>, { d, conEmpresa }: Comun): void {
  app.post('/panel/api/contingencia', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_EMISORES.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no registra ventas.');
    const b = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!b) return d.error(c, 422, 'DATOS_INVALIDOS', 'Datos inválidos.');
    const canal = await d.db.query(`SELECT id FROM canales WHERE empresa_id = $1 AND nombre = $2 AND tipo = 'MANUAL' AND activo`, [
      s.empresa.id, typeof b.canal === 'string' ? b.canal : '',
    ]);
    const { canal: _canal, ...cuerpo } = b;
    try {
      const r = await registrarContingencia(d.db, {
        empresaId: s.empresa.id, usuarioId: s.usuarioId, cuerpo, ...(canal.rows[0] ? { canalId: canal.rows[0].id as string } : {}),
      });
      return c.json(r, r.resultado === 'REGISTRADA' ? 201 : 200);
    } catch (e) {
      if (e instanceof ErrorContingencia) return d.error(c, 422, 'DATOS_INVALIDOS', 'No se pudo registrar la venta sin internet.', e.errores);
      throw e;
    }
  });

  app.get('/panel/api/contingencia', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño, un administrador o el contador ven lo que falta informar.');
    return c.json({ dias: await diasDeContingencia(d.db, s.empresa.id) });
  });

  // El archivo para SUNAT: dueño, administrador o contador (quien lo carga en SOL).
  app.post('/panel/api/contingencia/informe', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño, un administrador o el contador preparan el archivo para SUNAT.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!esFecha(b.fecha)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Indica la fecha de las ventas.');
    try {
      const r = await generarInforme(d.db, d.almacen, { empresaId: s.empresa.id, fecha: b.fecha, usuarioId: s.usuarioId });
      return c.body(new Uint8Array(r.zip), 200, {
        'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${r.nombre}"`, 'Cache-Control': 'private, no-store',
      });
    } catch (e) {
      if (e instanceof ErrorContingencia) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });
}
