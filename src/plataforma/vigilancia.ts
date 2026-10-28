/**
 * Vigilancia de la plataforma: detecta problemas ANTES de que el cliente reclame y avisa por
 * correo a los administradores de la plataforma. Corre en cada pasada del cron (cada 5 min);
 * cada aviso sale UNA vez (tabla avisos_plataforma).
 *
 * Qué revisa:
 *   - Errores internos del servidor (cualquier "error 500").
 *   - Comprobantes atascados: más de 2 horas sin llegar a SUNAT.
 *   - Muchos rechazos de SUNAT en un día (suele ser un dato mal configurado).
 *   - Certificados digitales de cualquier cliente por vencer (15 días) o vencidos.
 *   - Planes de clientes por vencer (3 días) o vencidos: para cobrar a tiempo.
 *   - Base de datos cerca del límite del plan de Supabase.
 */
import type { EnviarCorreo } from '../avisos/avisos.js';
import type { Db } from '../db/conexion.js';
import { ahoraLima } from '../fechas.js';

/** Tamaño del plan gratis de Supabase (oct. 2026). Si contratas uno mayor, cambia este número. */
const LIMITE_BD_MB = 500;
const AVISO_BD_PORCENTAJE = 80;

export interface Problema {
  tipo: string;
  /** Identifica el aviso: el mismo problema no se avisa dos veces. */
  clave: string;
  nivel: 'ROJO' | 'AMARILLO';
  mensaje: string;
}

/** Guarda un error interno (sin datos del pedido: solo el mensaje y la ruta). Nunca lanza. */
export async function registrarError(db: Db, origen: string, mensaje: string, ruta?: string): Promise<void> {
  await db.query(`INSERT INTO errores_plataforma (origen, mensaje, ruta) VALUES ($1, $2, $3)`, [origen, mensaje.slice(0, 500), ruta?.slice(0, 200) ?? null])
    .catch(() => undefined);
}

export async function revisarPlataforma(db: Db, hoy = ahoraLima().fecha): Promise<Problema[]> {
  const problemas: Problema[] = [];

  const errores = (await db.query(
    `SELECT count(*)::int AS n, max(id) AS ultimo, (array_agg(mensaje ORDER BY id DESC))[1] AS mensaje
       FROM errores_plataforma WHERE avisado_en IS NULL`,
  )).rows[0];
  if (errores.n > 0) {
    problemas.push({ tipo: 'ERRORES', clave: String(errores.ultimo), nivel: 'ROJO',
      mensaje: `${errores.n} error(es) interno(s) del servidor. El último: "${errores.mensaje}". Revisa "Salud de la plataforma" en el panel.` });
  }

  for (const f of (await db.query(
    `SELECT e.ruc, e.razon_social, count(*)::int AS n FROM comprobantes c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.estado IN ('EMITIDO_LOCAL', 'PENDIENTE_ENVIO') AND c.creado_en < now() - interval '2 hours'
      GROUP BY e.id ORDER BY e.razon_social`,
  )).rows) {
    problemas.push({ tipo: 'COLA', clave: `${f.ruc}:${hoy}`, nivel: 'ROJO',
      mensaje: `${f.razon_social} (${f.ruc}): ${f.n} comprobante(s) llevan más de 2 horas sin llegar a SUNAT. Revisa que el cron esté corriendo y que SUNAT responda.` });
  }

  for (const f of (await db.query(
    `SELECT e.ruc, e.razon_social, count(*)::int AS n FROM comprobantes c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.estado = 'RECHAZADO' AND c.creado_en > now() - interval '24 hours'
      GROUP BY e.id HAVING count(*) >= 3 ORDER BY e.razon_social`,
  )).rows) {
    problemas.push({ tipo: 'RECHAZOS', clave: `${f.ruc}:${hoy}`, nivel: 'ROJO',
      mensaje: `${f.razon_social} (${f.ruc}): SUNAT rechazó ${f.n} comprobantes en 24 horas. Suele ser un dato de la empresa mal configurado.` });
  }

  for (const f of (await db.query(
    `SELECT e.ruc, e.razon_social, c.valido_hasta::date::text AS vence, (c.valido_hasta::date - $1::date)::int AS dias
       FROM certificados c JOIN empresas e ON e.id = c.empresa_id
      WHERE c.activo AND c.valido_hasta::date - $1::date <= 15 ORDER BY dias`,
    [hoy],
  )).rows) {
    problemas.push({ tipo: 'CERTIFICADO', clave: `${f.ruc}:${f.vence}:${f.dias < 0 ? 'vencido' : 'pronto'}`, nivel: f.dias < 0 ? 'ROJO' : 'AMARILLO',
      mensaje: `${f.razon_social} (${f.ruc}): su certificado digital ${f.dias < 0 ? 'VENCIÓ' : `vence en ${f.dias} día(s)`} (${f.vence}). Sin él no puede emitir.` });
  }

  for (const f of (await db.query(
    `SELECT e.ruc, e.razon_social, s.vence_en::text AS vence, (s.vence_en - $1::date)::int AS dias, s.dias_gracia, s.contacto
       FROM suscripciones s JOIN empresas e ON e.id = s.empresa_id
      WHERE s.estado IN ('PRUEBA', 'ACTIVA') AND s.vence_en - $1::date <= 3 AND s.vence_en - $1::date >= -s.dias_gracia - 1
      ORDER BY dias`,
    [hoy],
  )).rows) {
    const cuando = f.dias > 0 ? `vence en ${f.dias} día(s)` : f.dias === 0 ? 'vence HOY' : f.dias < -f.dias_gracia ? 'VENCIÓ y ya no puede emitir' : 'venció (está en días de gracia)';
    problemas.push({ tipo: 'PLAN', clave: `${f.ruc}:${f.vence}:${f.dias > 0 ? 'pronto' : f.dias < -f.dias_gracia ? 'vencido' : 'gracia'}`, nivel: f.dias < 0 ? 'ROJO' : 'AMARILLO',
      mensaje: `${f.razon_social} (${f.ruc}): su plan ${cuando} (${f.vence}).${f.contacto ? ` Contacto: ${f.contacto}.` : ''}` });
  }

  const bd = (await db.query(`SELECT (pg_database_size(current_database()) / 1048576)::int AS mb`)).rows[0].mb as number;
  if (bd * 100 >= LIMITE_BD_MB * AVISO_BD_PORCENTAJE) {
    problemas.push({ tipo: 'BASE_DATOS', clave: `${Math.floor(bd / 25) * 25}`, nivel: bd >= LIMITE_BD_MB ? 'ROJO' : 'AMARILLO',
      mensaje: `La base de datos usa ${bd} MB de ${LIMITE_BD_MB} MB del plan. Pasa a un plan mayor de Supabase antes de que se llene.` });
  }
  return problemas;
}

/** Revisa y manda por correo, a los administradores de la plataforma, lo que aún no se avisó. */
export async function vigilarPlataforma(db: Db, enviar: EnviarCorreo | undefined, hoy = ahoraLima().fecha): Promise<number> {
  const problemas = await revisarPlataforma(db, hoy);
  if (!problemas.length || !enviar) return 0;
  const para = (await db.query(`SELECT lower(email) AS email FROM usuarios WHERE admin_plataforma AND activo`)).rows.map((x) => x.email as string);
  if (!para.length) return 0;
  const nuevos: Problema[] = [];
  for (const p of problemas) {
    const r = await db.query(`INSERT INTO avisos_plataforma (tipo, clave) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`, [p.tipo, p.clave]);
    if (r.rowCount) nuevos.push(p);
  }
  if (!nuevos.length) return 0;
  const rojos = nuevos.filter((p) => p.nivel === 'ROJO').length;
  try {
    await enviar({
      para,
      asunto: rojos ? `⚠️ Facturador: ${rojos} problema(s) que atender` : `Facturador: ${nuevos.length} aviso(s)`,
      texto: `${nuevos.map((p) => `${p.nivel === 'ROJO' ? '🔴' : '🟡'} ${p.mensaje}`).join('\n\n')}\n\nDetalle en el panel → Plataforma.`,
    });
  } catch (e) {
    // No salió: se liberan para reintentar en la próxima pasada.
    for (const p of nuevos) await db.query(`DELETE FROM avisos_plataforma WHERE tipo = $1 AND clave = $2`, [p.tipo, p.clave]);
    throw e;
  }
  await db.query(`UPDATE errores_plataforma SET avisado_en = now() WHERE avisado_en IS NULL`);
  return 1;
}

/** Para el panel: problemas de ahora, últimos errores y números generales. */
export async function saludPlataforma(db: Db) {
  const errores = (await db.query(`SELECT origen, mensaje, ruta, creado_en FROM errores_plataforma ORDER BY id DESC LIMIT 20`)).rows;
  const n = (await db.query(
    `SELECT (SELECT count(*) FROM comprobantes WHERE estado IN ('EMITIDO_LOCAL', 'PENDIENTE_ENVIO'))::int AS en_cola,
            (SELECT count(*) FROM comprobantes WHERE creado_en > now() - interval '24 hours')::int AS ultimas_24h,
            (pg_database_size(current_database()) / 1048576)::int AS bd_mb`,
  )).rows[0];
  return {
    problemas: await revisarPlataforma(db),
    errores: errores.map((e) => ({ origen: e.origen, mensaje: e.mensaje, ruta: e.ruta, fecha: new Date(e.creado_en).toISOString() })),
    enCola: n.en_cola, ultimas24h: n.ultimas_24h, baseDatosMb: n.bd_mb, limiteBaseDatosMb: LIMITE_BD_MB,
  };
}
