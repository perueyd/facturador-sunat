/**
 * Avisos por correo al dueño y a los administradores de cada empresa:
 *   - Declaración mensual: 7 días antes, 3 días antes y el mismo día.
 *   - Certificado digital: 60, 30 y 7 días antes de vencer.
 *   - Alertas rojas (ej. comprobante rechazado por SUNAT), una por alerta.
 * Se revisa en cada pasada del cron; `avisos_enviados` garantiza que cada aviso salga
 * UNA sola vez. Si un día no corrió el cron, el aviso sale al siguiente (por tramos).
 * Sin proveedor de correo configurado (RESEND_API_KEY), no hace nada.
 */
import type { Db } from '../db/conexion.js';
import { ahoraLima } from '../fechas.js';
import { MODULOS, tablero, type Modulo } from '../reportes/tablero.js';

export interface Correo {
  para: string[];
  asunto: string;
  texto: string;
}
export type EnviarCorreo = (c: Correo) => Promise<void>;

/** Correo con Resend (https://resend.com, plan gratis). El remitente debe estar verificado allí. */
export function correoResend(apiKey: string, desde: string): EnviarCorreo {
  return async (c) => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: desde, to: c.para, subject: c.asunto, text: c.texto }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`El proveedor de correo respondió ${r.status}.`);
  };
}

/** Tramo del aviso: el menor umbral que ya se alcanzó (ej. faltan 5 días → tramo "7"). */
export function tramo(dias: number, umbrales: number[]): number | undefined {
  return [...umbrales].sort((a, b) => a - b).find((u) => dias <= u);
}

const FECHA = new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fechaLarga = (iso: string) => FECHA.format(new Date(`${iso}T00:00:00Z`));

interface Pendiente {
  tipo: string;
  clave: string;
  asunto: string;
  texto: string;
}

async function pendientesDe(db: Db, empresa: { id: string; razon: string; modulos: Modulo[] }, hoy: string): Promise<Pendiente[]> {
  const avisos: Pendiente[] = [];
  const t = await tablero(db, empresa.id, { hoy, modulos: empresa.modulos });
  const v = t.vencimiento;
  if (v && !('faltaCronograma' in v)) {
    const u = tramo(v.dias, [0, 3, 7]);
    if (u !== undefined && v.dias >= 0) {
      const cuando = v.dias === 0 ? 'HOY' : v.dias === 1 ? 'MAÑANA' : `en ${v.dias} días`;
      const resumen = t.resumen
        ? `\nIGV estimado a pagar: S/ ${t.resumen.igvPorPagar}${t.resumen.rentaPagoCuenta ? ` · Renta (pago a cuenta) estimada: S/ ${t.resumen.rentaPagoCuenta.monto}` : ''}.\nSon estimados: confírmalos con tu contador.`
        : '';
      avisos.push({
        tipo: 'VENCIMIENTO', clave: `${v.periodo}:${u}`,
        asunto: `${empresa.razon}: declarar y pagar ${v.nombre} vence ${cuando}`,
        texto: `La declaración y pago de ${v.nombre} (IGV y Renta) vence el ${fechaLarga(v.vence)} (${cuando}).${resumen}\n\nFuente: cronograma oficial de SUNAT, según el último dígito de tu RUC.`,
      });
    }
  }
  const c = t.certificado;
  if (c && !('falta' in c)) {
    const u = tramo(c.dias, [7, 30, 60]);
    if (u !== undefined) {
      avisos.push({
        tipo: 'CERTIFICADO', clave: `${c.vence}:${u}`,
        asunto: `${empresa.razon}: tu certificado digital ${c.dias < 0 ? 'VENCIÓ' : `vence en ${c.dias} días`}`,
        texto: `El certificado digital con el que se firman tus comprobantes ${c.dias < 0 ? 'venció' : 'vence'} el ${fechaLarga(c.vence)}.\nSin un certificado vigente no se pueden emitir comprobantes: renuévalo y cárgalo con "npm run certificado:cargar".`,
      });
    }
  }
  // Alertas rojas (comprobante rechazado, etc.) de los últimos 7 días.
  const a = await db.query(
    `SELECT id, mensaje FROM alertas WHERE empresa_id = $1 AND severidad = 'ROJO' AND resuelta_en IS NULL AND creado_en > now() - interval '7 days' ORDER BY id`,
    [empresa.id],
  );
  for (const x of a.rows) {
    avisos.push({ tipo: 'ALERTA', clave: String(x.id), asunto: `${empresa.razon}: atención`, texto: `${x.mensaje}\n\nRevísalo en el panel del facturador.` });
  }
  return avisos;
}

/** Revisa todas las empresas y envía lo que toque. Devuelve cuántos correos salieron. */
export async function enviarAvisos(db: Db, enviar: EnviarCorreo, hoy = ahoraLima().fecha): Promise<number> {
  const empresas = await db.query(
    `SELECT e.id, e.razon_social, e.modulos_desactivados,
            array_agg(DISTINCT lower(u.email)) FILTER (WHERE u.id IS NOT NULL) AS correos
       FROM empresas e
       LEFT JOIN usuario_empresa ue ON ue.empresa_id = e.id AND ue.rol IN ('DUENO', 'ADMIN')
       LEFT JOIN usuarios u ON u.id = ue.usuario_id AND u.activo
      WHERE NOT ('avisos' = ANY(e.modulos_desactivados))
      GROUP BY e.id`,
  );
  let enviados = 0;
  for (const e of empresas.rows) {
    const para = (e.correos as string[] | null) ?? [];
    if (!para.length) continue;
    const modulos = MODULOS.filter((m) => !(e.modulos_desactivados as string[]).includes(m));
    for (const p of await pendientesDe(db, { id: e.id, razon: e.razon_social, modulos }, hoy)) {
      // Primero se reserva (la clave única evita que dos pasadas del cron lo envíen dos veces).
      const reservado = await db.query(
        `INSERT INTO avisos_enviados (empresa_id, tipo, clave, destinos) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
        [e.id, p.tipo, p.clave, para],
      );
      if (!reservado.rowCount) continue;
      try {
        await enviar({ para, asunto: p.asunto, texto: p.texto });
        enviados++;
      } catch (err) {
        // Falló el envío: se libera la reserva para reintentar en la próxima pasada.
        await db.query(`DELETE FROM avisos_enviados WHERE id = $1`, [reservado.rows[0].id]);
        console.error('[avisos] no se pudo enviar:', err instanceof Error ? err.message : err);
      }
    }
  }
  return enviados;
}
