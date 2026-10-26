/**
 * Segundo paso del panel (TOTP) y contraseñas. Un error aquí deja entrar a quien no
 * debe o deja fuera al dueño.
 */
import { describe, expect, it } from 'vitest';
import { hashContrasena, verificarContrasena } from '../src/seguridad/contrasenas.js';
import { base32, codigoTotp, verificarTotp } from '../src/seguridad/totp.js';

const SECRETO_RFC = Buffer.from('12345678901234567890');

describe('TOTP (RFC 6238)', () => {
  it('coincide con los vectores oficiales del RFC (SHA-1)', () => {
    // RFC 6238, apéndice B: T=59 → 94287082; T=1111111109 → 07081804 (8 dígitos).
    expect(codigoTotp(SECRETO_RFC, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(codigoTotp(SECRETO_RFC, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(codigoTotp(SECRETO_RFC, 1)).toBe('287082');
  });

  it('base32 como lo leen las apps autenticadoras', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(SECRETO_RFC)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('acepta un paso de desfase de reloj, no más', () => {
    const ahora = 1_000_000 * 30_000;
    const paso = 1_000_000;
    expect(verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, paso), { ahora })).toBe(paso);
    expect(verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, paso - 1), { ahora })).toBe(paso - 1);
    expect(verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, paso + 1), { ahora })).toBe(paso + 1);
    expect(verificarTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, paso - 2), { ahora })).toBeUndefined();
  });

  it('un código ya usado no vale otra vez', () => {
    const ahora = 1_000_000 * 30_000;
    const codigo = codigoTotp(SECRETO_RFC, 1_000_000);
    expect(verificarTotp(SECRETO_RFC, codigo, { ahora, ultimoPaso: 1_000_000 })).toBeUndefined();
  });

  it('rechaza lo que no son 6 dígitos', () => {
    expect(verificarTotp(SECRETO_RFC, '12345')).toBeUndefined();
    expect(verificarTotp(SECRETO_RFC, 'abcdef')).toBeUndefined();
  });
});

describe('contraseñas', () => {
  it('se guardan con scrypt y sal propia; solo la correcta pasa', async () => {
    const a = await hashContrasena('una clave larga 2026');
    const b = await hashContrasena('una clave larga 2026');
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toBe(b);
    expect(await verificarContrasena('una clave larga 2026', a)).toBe(true);
    expect(await verificarContrasena('una clave larga 2027', a)).toBe(false);
    expect(await verificarContrasena('cualquiera', null)).toBe(false);
  });

  it('exige un mínimo de 10 caracteres', async () => {
    await expect(hashContrasena('corta')).rejects.toThrow(/10 caracteres/);
  });
});
