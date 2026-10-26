/**
 * Lectura de contraseñas por teclado. En Windows la pregunta no se veía y el dueño
 * tuvo que pasar la clave del certificado por una variable visible en pantalla.
 */
import { describe, expect, it } from 'vitest';
import { teclear } from '../scripts/lib/consola.js';

describe('teclear', () => {
  it('muestra un * por letra y nunca la letra', () => {
    const r = teclear({ texto: '' }, 'abc');
    expect(r).toEqual({ estado: { texto: 'abc' }, eco: '***' });
  });

  it('Enter termina; lo pegado de una vez también vale', () => {
    expect(teclear({ texto: '' }, 'Clave#2026\r').estado).toEqual({ texto: 'Clave#2026', fin: 'enter' });
  });

  it('borrar quita la última letra y su asterisco; sin texto no borra la pregunta', () => {
    expect(teclear({ texto: 'añ' }, '\u007f')).toEqual({ estado: { texto: 'a' }, eco: '\b \b' });
    expect(teclear({ texto: '' }, '\b')).toEqual({ estado: { texto: '' }, eco: '' });
  });

  it('Ctrl+C cancela', () => {
    expect(teclear({ texto: 'abc' }, '\u0003').estado.fin).toBe('cancelar');
  });

  it('ignora teclas de control como las flechas', () => {
    expect(teclear({ texto: '' }, '\u001b[Aa\u001b[3~b')).toEqual({ estado: { texto: 'ab' }, eco: '**' });
  });
});
