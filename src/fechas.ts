/** Fecha y hora oficiales de Lima (UTC−5), sin depender de la zona del servidor. */
export function ahoraLima(ahora: Date = new Date()): { fecha: string; hora: string } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ahora);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '00';
  return { fecha: `${p('year')}-${p('month')}-${p('day')}`, hora: `${p('hour')}:${p('minute')}:${p('second')}` };
}

const DIA_MS = 86_400_000;

/**
 * Fecha AAAA-MM-DD que existe de verdad. El patrón solo no basta: "2026-02-30" pasaba y
 * PostgreSQL la rechazaba después con un error 500 en vez de un mensaje claro.
 */
export function esFecha(texto: unknown): texto is string {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

/** Suma (o resta, con negativo) días a una fecha AAAA-MM-DD. */
export const sumarDias = (iso: string, dias: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);

/** Días de una fecha AAAA-MM-DD a otra. */
export const diasEntre = (desde: string, hasta: string): number => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
