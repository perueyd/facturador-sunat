/**
 * Los archivos del panel (src/panel/publico/*.js) se cargan como scripts clásicos y comparten
 * el mismo espacio de nombres. Si dos declaran la misma constante o función con const/let,
 * el navegador detiene el segundo archivo y el panel queda en blanco, aunque cada archivo por
 * separado esté bien escrito (ya pasó con `hoyLima`, que estaba en cobros.js y en ajustes.js).
 * Se juntan en el orden de index.html y se compilan como un solo script: así se detecta.
 */
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const carpeta = new URL('../src/panel/publico/', import.meta.url);

describe('scripts del panel', () => {
  it('ningún nombre se declara dos veces entre archivos', () => {
    const html = readFileSync(new URL('index.html', carpeta), 'utf8');
    const archivos = [...html.matchAll(/<script src="\/panel\/([a-z]+\.js)"/g)].map((m) => m[1]!);
    expect(archivos.length).toBeGreaterThan(3);
    const todo = archivos.map((a) => readFileSync(new URL(a, carpeta), 'utf8').replace(/^'use strict';/m, '')).join('\n;\n');
    expect(() => new Script(todo)).not.toThrow();
  });
});
