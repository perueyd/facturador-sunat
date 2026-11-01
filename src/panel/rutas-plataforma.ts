/**
 * Rutas del panel · Plataforma (solo su administrador) y reportes de los usuarios.
 * Se registran desde rutas.ts, que arma la sesión y los ayudantes comunes (ver comun-rutas.ts).
 */
import type { Context, Hono } from 'hono';
import { ErrorInvitacion, invitar } from './invitaciones.js';
import { ErrorSuscripcion, actividadPlataforma, cambiarSuscripcion, clientes, registrarPago as registrarPagoPlan } from '../plataforma/suscripciones.js';
import { saludPlataforma } from '../plataforma/vigilancia.js';
import { SECCIONES_DE_PLAN } from '../reportes/tablero.js';
import { UUID } from './comun-rutas.js';
import type { Comun } from './comun-rutas.js';

export function registrarPlataforma(app: Hono<any>, { d, conSesion, texto, frenado, enlaceInvitacion, avisarInvitacion }: Comun): void {
  // ---------- Plataforma: tus clientes, sus planes y la salud del sistema ----------
  // Solo para administradores de la plataforma (npm run usuario -- plataforma --email …).
  const conPlataforma = async (c: Context) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    return s.adminPlataforma ? s : d.error(c, 403, 'SIN_PERMISO', 'Solo el administrador de la plataforma.');
  };
  const empresaDeRuta = async (c: Context) => {
    const id = c.req.param('empresaId') ?? '';
    return UUID.test(id) && (await d.db.query(`SELECT 1 FROM empresas WHERE id = $1`, [id])).rowCount ? id : undefined;
  };

  app.get('/panel/api/plataforma', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const planes = (await d.db.query(
      `SELECT codigo, nombre, precio_mensual::text AS mensual, precio_anual::text AS anual, comprobantes_mes, usuarios_max, activo, secciones FROM planes ORDER BY precio_mensual`,
    )).rows.map((p) => ({
      codigo: p.codigo, nombre: p.nombre, mensual: p.mensual, anual: p.anual, comprobantesMes: p.comprobantes_mes, usuariosMax: p.usuarios_max, activo: p.activo, secciones: p.secciones,
    }));
    return c.json({ ...(await clientes(d.db)), planes, actividad: await actividadPlataforma(d.db) });
  });

  app.get('/panel/api/plataforma/salud', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    return c.json(await saludPlataforma(d.db));
  });

  app.post('/panel/api/plataforma/:empresaId/pago', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const empresaId = await empresaDeRuta(c);
    if (!empresaId) return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const r = await registrarPagoPlan(d.db, {
        empresaId, usuarioId: s.usuarioId, periodo: texto(b.periodo, 10) as 'MENSUAL' | 'ANUAL', medio: texto(b.medio, 60),
        ...(texto(b.monto, 12) ? { monto: texto(b.monto, 12) } : {}), ...(texto(b.referencia, 120) ? { referencia: texto(b.referencia, 120) } : {}),
        ...(texto(b.plan, 20) ? { plan: texto(b.plan, 20) } : {}),
      });
      return c.json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof ErrorSuscripcion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  app.post('/panel/api/plataforma/:empresaId/cambio', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const empresaId = await empresaDeRuta(c);
    if (!empresaId) return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      await cambiarSuscripcion(d.db, {
        empresaId, usuarioId: s.usuarioId, motivo: texto(b.motivo, 300),
        ...(texto(b.plan, 20) ? { plan: texto(b.plan, 20) } : {}),
        ...(texto(b.estado, 20) ? { estado: texto(b.estado, 20) as 'ACTIVA' | 'SUSPENDIDA' | 'CANCELADA' } : {}),
      });
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof ErrorSuscripcion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Invitar al DUEÑO de la empresa de un cliente: recibe su enlace y configura todo él mismo.
  app.post('/panel/api/plataforma/:empresaId/invitar', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const empresaId = await empresaDeRuta(c);
    if (!empresaId) return d.error(c, 404, 'NO_ENCONTRADO', 'Empresa no encontrada.');
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const r = await invitar(d.db, { email: texto(b.email, 200), nombre: texto(b.nombre, 120), empresaId, rol: 'DUENO', creadaPor: s.usuarioId });
      if (r.existente) return c.json({ ok: true, existente: true });
      const razon = (await d.db.query(`SELECT razon_social FROM empresas WHERE id = $1`, [empresaId])).rows[0].razon_social as string;
      const enlace = enlaceInvitacion(c, r.token);
      avisarInvitacion(texto(b.email, 200).toLowerCase(), enlace, razon);
      return c.json({ ok: true, existente: false, enlace, expira: r.expira, porCorreo: Boolean(d.correo) }, 201);
    } catch (e) {
      if (e instanceof ErrorInvitacion) return d.error(c, 422, 'DATOS_INVALIDOS', e.message);
      throw e;
    }
  });

  // Precios de los planes: los decide el dueño de la plataforma (los de fábrica son una propuesta).
  app.post('/panel/api/plataforma/planes/:codigo', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const monto = (v: unknown) => (typeof v === 'string' && /^\d{1,8}(\.\d{1,2})?$/.test(v) ? v : undefined);
    const entero = (v: unknown) => (v === null || v === '' ? null : typeof v === 'string' && /^[1-9]\d{0,6}$/.test(v) ? Number(v) : undefined);
    const mensual = monto(b.mensual);
    const anual = monto(b.anual);
    const comprobantes = entero(b.comprobantesMes);
    const usuarios = entero(b.usuariosMax);
    if (!mensual || !anual || comprobantes === undefined || usuarios === undefined) {
      return d.error(c, 422, 'DATOS_INVALIDOS', 'Precios como 39.00; límites como números enteros (vacío = sin límite).');
    }
    // Secciones del plan (opcional): solo las que se reparten por plan.
    const secciones = Array.isArray(b.secciones) ? b.secciones.filter((x): x is string => typeof x === 'string') : undefined;
    if (secciones && secciones.some((x) => !(SECCIONES_DE_PLAN as readonly string[]).includes(x))) {
      return d.error(c, 422, 'DATOS_INVALIDOS', `Secciones válidas: ${SECCIONES_DE_PLAN.join(', ')}.`);
    }
    const r = await d.db.query(
      `UPDATE planes SET precio_mensual = $2, precio_anual = $3, comprobantes_mes = $4, usuarios_max = $5, secciones = coalesce($6, secciones) WHERE codigo = $1 RETURNING 1`,
      [c.req.param('codigo'), mensual, anual, comprobantes, usuarios, secciones ?? null],
    );
    if (!r.rowCount) return d.error(c, 404, 'NO_ENCONTRADO', 'Plan no encontrado.');
    await d.db.query(`INSERT INTO auditoria (usuario_id, accion, entidad, despues) VALUES ($1, 'CAMBIO_PLAN_PRECIOS', 'planes', $2)`, [
      s.usuarioId, JSON.stringify({ codigo: c.req.param('codigo'), mensual, anual, comprobantes, usuarios, secciones: secciones ?? null }),
    ]);
    return c.json({ ok: true });
  });

  // ---------- Reportes: "algo no funciona" o "me falta esto" ----------
  app.post('/panel/api/reportes', async (c) => {
    const s = await conSesion(c);
    if (s instanceof Response) return s;
    const ip = d.ipCliente(c);
    // Cada reporte cuenta: frena a quien quiera llenar el correo del administrador.
    if (d.fallos.excedido(ip) || !d.fallos.contar(ip)) return frenado(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const tipo = texto(b.tipo, 20) === 'SUGERENCIA' ? 'SUGERENCIA' : 'PROBLEMA';
    const mensaje = texto(b.mensaje, 2000).trim();
    if (mensaje.length < 5) return d.error(c, 422, 'DATOS_INVALIDOS', 'Cuéntanos un poco más (mínimo 5 letras).');
    const pantalla = texto(b.pantalla, 40) || null;
    await d.db.query(`INSERT INTO reportes (empresa_id, usuario_id, tipo, mensaje, pantalla) VALUES ($1, $2, $3, $4, $5)`, [
      s.empresa?.id ?? null, s.usuarioId, tipo, mensaje, pantalla,
    ]);
    const para = (await d.db.query(`SELECT lower(email) AS email FROM usuarios WHERE admin_plataforma AND activo`)).rows.map((x) => x.email as string);
    if (para.length) {
      void d.correo?.({
        para, asunto: `Facturador: ${tipo === 'PROBLEMA' ? '⚠️ problema reportado' : 'sugerencia'} de ${s.empresa?.razonSocial ?? s.nombre}`,
        texto: `${s.nombre} (${s.email})${s.empresa ? ` · ${s.empresa.razonSocial} (${s.empresa.ruc})` : ''}${pantalla ? ` · pantalla: ${pantalla}` : ''}\n\n${mensaje}\n\nMárcalo como atendido en el panel → Plataforma.`,
      }).catch((e: unknown) => console.error('[reportes] no se pudo enviar:', e instanceof Error ? e.message : e));
    }
    return c.json({ ok: true }, 201);
  });

  app.get('/panel/api/plataforma/reportes', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const r = await d.db.query(
      `SELECT r.id, r.tipo, r.mensaje, r.pantalla, r.creado_en, u.nombre, u.email, e.razon_social
         FROM reportes r JOIN usuarios u ON u.id = r.usuario_id LEFT JOIN empresas e ON e.id = r.empresa_id
        WHERE r.atendido_en IS NULL ORDER BY r.id DESC LIMIT 100`,
    );
    return c.json({ reportes: r.rows.map((x) => ({
      id: String(x.id), tipo: x.tipo, mensaje: x.mensaje, pantalla: x.pantalla, fecha: new Date(x.creado_en).toISOString(),
      usuario: `${x.nombre} (${x.email})`, empresa: x.razon_social,
    })) });
  });

  app.post('/panel/api/plataforma/reportes/:id/atendido', async (c) => {
    const s = await conPlataforma(c);
    if (s instanceof Response) return s;
    const id = c.req.param('id');
    if (!/^\d{1,15}$/.test(id)) return d.error(c, 404, 'NO_ENCONTRADO', 'Reporte no encontrado.');
    const r = await d.db.query(`UPDATE reportes SET atendido_en = now(), atendido_por = $2 WHERE id = $1 AND atendido_en IS NULL RETURNING id`, [id, s.usuarioId]);
    return r.rowCount ? c.json({ ok: true }) : d.error(c, 404, 'NO_ENCONTRADO', 'Reporte no encontrado o ya atendido.');
  });
}
