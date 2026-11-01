/**
 * Lo que comparten las rutas del panel (rutas.ts y rutas-*.ts): roles, validaciones y la
 * sesión ya resuelta. La sesión y los permisos se arman UNA vez en rutas.ts y se pasan aquí.
 */
import type { Context } from 'hono';
import type { DependenciasPanel } from './rutas.js';
import type { Modulo } from '../reportes/tablero.js';
import type { Rol, Sesion } from './usuarios.js';

/** Notas de crédito, anulaciones, productos y stock: solo quienes responden por la empresa. */
export const ROLES_CORRIGEN: readonly Rol[] = ['DUENO', 'ADMIN'];
/** Compras de proveedores: también el contador. */
export const ROLES_COMPRAS: readonly Rol[] = ['DUENO', 'ADMIN', 'CONTADOR'];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CSV que Excel en español abre bien (BOM + punto y coma). Una celda que empieza con = + - @
 * sería una fórmula: se neutraliza.
 */
export function csvParaExcel(lineas: unknown[][]): string {
  const celda = (v: unknown) => {
    const t = String(v ?? '');
    const seguro = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return /[;"\n]/.test(seguro) ? `"${seguro.replaceAll('"', '""')}"` : seguro;
  };
  return '\uFEFF' + lineas.map((l) => l.map(celda).join(';')).join('\r\n') + '\r\n';
}

/** Origen público de esta petición (detrás de Render llega por https aunque el servidor vea http). */
export function origenPropio(c: Context): string {
  const url = new URL(c.req.url);
  return `${c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1)}://${url.host}`;
}

export interface Comun {
  d: DependenciasPanel;
  conSesion: (c: Context) => Promise<Sesion | Response>;
  conEmpresa: (c: Context) => Promise<Response | (Sesion & { empresa: NonNullable<Sesion['empresa']> })>;
  /** El comprobante si es de la empresa; si no, undefined (igual que si no existiera). */
  deLaEmpresa: (empresaId: string, id: string) => Promise<string | undefined>;
  sinModulo: (c: Context, m: Modulo) => Response;
  /** Texto recortado y con tope de largo. */
  texto: (v: unknown, max: number) => string;
  frenado: (c: Context) => Response;
  enlaceInvitacion: (c: Context, token: string) => string;
  avisarInvitacion: (para: string, enlace: string, empresa: string) => void;
}
