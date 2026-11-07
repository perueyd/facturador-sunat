/**
 * Validación de documentos de identidad peruanos.
 */

/** DNI: exactamente 8 dígitos. */
export function esDniValido(dni: string): boolean {
  return /^\d{8}$/.test(dni);
}

const PESOS_RUC = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const PREFIJOS_RUC = ['10', '15', '16', '17', '20'] as const;

/**
 * RUC: 11 dígitos, prefijo válido y dígito verificador (módulo 11).
 *
 * Algoritmo: se multiplican los 10 primeros dígitos por los pesos
 * 5,4,3,2,7,6,5,4,3,2; se suma; resto = suma % 11; dígito = 11 - resto,
 * y si da 10 → 0, si da 11 → 1.
 */
export function esRucValido(ruc: string): boolean {
  if (!/^\d{11}$/.test(ruc)) return false;
  if (!PREFIJOS_RUC.some((p) => ruc.startsWith(p))) return false;
  return digitoVerificadorRuc(ruc.slice(0, 10)) === Number(ruc[10]);
}

export function digitoVerificadorRuc(diezDigitos: string): number {
  if (!/^\d{10}$/.test(diezDigitos)) throw new Error('Se esperaban 10 dígitos');
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(diezDigitos[i]) * PESOS_RUC[i]!;
  const d = 11 - (suma % 11);
  return d === 10 ? 0 : d === 11 ? 1 : d;
}

/** Catálogo 06 de SUNAT: tipos de documento de identidad usados aquí. */
export const TipoDocIdentidad = {
  SIN_DOCUMENTO: '0', // "clientes varios": SUNAT beta lo aceptó (prueba 15/15, docs/PRUEBA_BETA.md)
  DNI: '1',
  CARNET_EXTRANJERIA: '4',
  RUC: '6',
  PASAPORTE: '7',
} as const;
export type TipoDocIdentidad = (typeof TipoDocIdentidad)[keyof typeof TipoDocIdentidad];
