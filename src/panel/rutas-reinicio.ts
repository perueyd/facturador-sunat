/**
 * Rutas del panel · Reiniciar los datos de PRUEBA (solo el dueño, solo en ambiente beta).
 * Guarda una copia antes de quitar nada y permite devolverla. Las reglas viven en la base
 * (migración 048): aquí solo se comprueba quién lo pide.
 */
import type { Hono } from 'hono';
import { ErrorReinicio, GRUPOS, estadoReinicio, reiniciar, restaurarCopia } from '../empresas/reinicio.js';
import { UUID } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';
import { confirmarContrasena } from './usuarios.js';

const SOLO_DUENO = 'Solo el dueño puede reiniciar los datos de prueba.';

export function registrarReinicio(app: Hono<any>, { d, conEmpresa, frenado }: Comun): void {
  app.get('/panel/api/reinicio', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', SOLO_DUENO);
    return c.json(await estadoReinicio(d.db, s.empresa.id));
  });

  // Reiniciar o restaurar: la palabra escrita a mano y la contraseña otra vez. Una sesión
  // abierta en un celular prestado no alcanza para dejar el panel en cero.
  app.post('/panel/api/reinicio', async (c) => {
    const s = await conEmpresa(c);
    if (s instanceof Response) return s;
    if (s.empresa.rol !== 'DUENO') return d.error(c, 403, 'SIN_PERMISO', SOLO_DUENO);
    const ip = d.ipCliente(c);
    if (d.fallos.excedido(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const restaurar = typeof b.restaurar === 'string' ? b.restaurar : '';
    if (restaurar && !UUID.test(restaurar)) return d.error(c, 422, 'DATOS_INVALIDOS', 'Esa copia no existe.');
    const palabra = restaurar ? 'RESTAURAR' : 'REINICIAR';
    if (b.confirmar !== palabra) return d.error(c, 422, 'FALTA_CONFIRMAR', `Escribe ${palabra} para confirmar.`);
    if (!(await confirmarContrasena(d.db, s.usuarioId, typeof b.contrasena === 'string' ? b.contrasena.slice(0, 200) : ''))) {
      return d.fallos.contar(ip) ? d.error(c, 422, 'CONTRASENA_INCORRECTA', 'La contraseña no es correcta.') : frenado(c);
    }
    try {
      const copia = restaurar
        ? await restaurarCopia(d.db, { empresaId: s.empresa.id, usuarioId: s.usuarioId, copiaId: restaurar })
        : await reiniciar(d.db, {
            empresaId: s.empresa.id, usuarioId: s.usuarioId,
            grupos: GRUPOS.filter((g) => Array.isArray(b.grupos) && b.grupos.includes(g)),
          });
      return c.json({ ok: true, copia, ...(await estadoReinicio(d.db, s.empresa.id)) });
    } catch (e) {
      if (e instanceof ErrorReinicio) return d.error(c, 409, 'NO_SE_PUDO', e.message);
      throw e;
    }
  });
}
