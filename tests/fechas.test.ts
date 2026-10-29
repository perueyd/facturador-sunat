/**
 * Fechas: una fecha que no existe ("2026-02-30") debe rechazarse con un mensaje claro antes
 * de llegar a PostgreSQL, que la rechazaba con un error 500.
 */
import { describe, expect, it } from 'vitest';
import { ahoraLima, diasEntre, esFecha, sumarDias } from '../src/fechas.js';

describe('fechas', () => {
  it('esFecha acepta solo días que existen', () => {
    expect(esFecha('2026-10-29')).toBe(true);
    expect(esFecha('2028-02-29')).toBe(true); // bisiesto
    expect(esFecha('2026-02-29')).toBe(false);
    expect(esFecha('2026-02-30')).toBe(false);
    expect(esFecha('2026-13-01')).toBe(false);
    expect(esFecha('2026-1-1')).toBe(false);
    expect(esFecha('29/10/2026')).toBe(false);
    expect(esFecha(undefined)).toBe(false);
  });

  it('sumarDias y diasEntre cruzan meses y años', () => {
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(diasEntre('2026-12-25', '2027-01-04')).toBe(10);
  });

  it('ahoraLima usa la hora de Perú aunque el servidor esté en UTC', () => {
    // 02:00 UTC del 29 = 21:00 del 28 en Lima.
    expect(ahoraLima(new Date('2026-10-29T02:00:00Z'))).toEqual({ fecha: '2026-10-28', hora: '21:00:00' });
  });
});
