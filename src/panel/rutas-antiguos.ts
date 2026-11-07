/**
 * Rutas del panel · Comprobantes antiguos (función OPCIONAL "antiguos", viene apagada):
 * los emitidos antes de este facturador, subidos como XML de SUNAT para consultarlos.
 * Solo historial: no se envían a SUNAT ni cuentan en ventas, impuestos ni correlativos.
 */
import type { Hono } from 'hono';
import { ErrorAntiguo, listarAntiguos, subirAntiguos, xmlAntiguo } from '../antiguos/antiguos.js';
import { ROLES_COMPRAS, ROLES_CORRIGEN, UUID } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';

export function registrarAntiguos(app: Hono<any>, { d, conEmpresa, sinModulo, texto }: Comun): void {
  // Prender o apagar la función: solo el dueño (funciona aunque esté apagada, para poder prenderla).
  app.post('/panel/api/antiguos/activar', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño prende o apaga los comprobantes antiguos.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.activo !== 'boolean') return d.error(c, 422, 'DATOS_INVALIDOS', 'Indica si se activa o no.');
    // Apagar solo la oculta: lo ya subido se conserva y vuelve a verse al prenderla.
    await d.db.query(
      `UPDATE empresas SET modulos_desactivados = CASE WHEN $2
         THEN array_remove(modulos_desactivados, 'antiguos')
         ELSE array_append(array_remove(modulos_desactivados, 'antiguos'), 'antiguos') END
       WHERE id = $1`,
      [s.empresa.id, b.activo],
    );
    await d.db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'MODULO_ANTIGUOS', 'empresas', $1, $3)`, [
      s.empresa.id, s.usuarioId, JSON.stringify({ activo: b.activo }),
    ]);
    return c.json({ ok: true, activo: b.activo });
  });

  app.get('/panel/api/antiguos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('antiguos')) return sinModulo(c, 'antiguos');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no ve los comprobantes antiguos.');
    const anio = Number(c.req.query('anio'));
    const buscar = texto(c.req.query('buscar'), 60);
    return c.json({
      comprobantes: await listarAntiguos(d.db, s.empresa.id, { ...(buscar ? { buscar } : {}), ...(Number.isInteger(anio) && anio > 1990 ? { anio } : {}) }),
    });
  });

  // Un archivo por pedido (XML o el ZIP que descarga SUNAT); el panel manda uno tras otro.
  app.post('/panel/api/antiguos', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('antiguos')) return sinModulo(c, 'antiguos');
    if (!ROLES_CORRIGEN.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Solo el dueño o un administrador sube comprobantes antiguos.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const base64 = typeof b.archivo === 'string' ? b.archivo.replace(/^data:[\w./+-]*;base64,/, '') : '';
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Archivo inválido.');
    try {
      const resultados = await subirAntiguos(d.db, d.almacen, {
        empresaId: s.empresa.id, nombre: texto(b.nombre, 120) || 'archivo', contenido: Buffer.from(base64, 'base64'), usuarioId: s.usuarioId,
      });
      return c.json({ resultados });
    } catch (e) {
      if (e instanceof ErrorAntiguo) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  app.get('/panel/api/antiguos/:id/xml', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (!s.empresa.modulos.includes('antiguos')) return sinModulo(c, 'antiguos');
    if (!ROLES_COMPRAS.includes(s.empresa.rol)) return d.error(c, 403, 'SIN_PERMISO', 'Tu rol no ve los comprobantes antiguos.');
    const id = c.req.param('id');
    const f = UUID.test(id) ? await xmlAntiguo(d.db, d.almacen, s.empresa.id, id) : undefined;
    if (!f) return d.error(c, 404, 'NO_ENCONTRADO', 'Comprobante no encontrado.');
    return c.body(new Uint8Array(f.xml), 200, {
      'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.nombre}"`, 'Cache-Control': 'private, no-store',
    });
  });
}
