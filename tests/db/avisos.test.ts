/**
 * Avisos por correo: que lleguen a tiempo, UNA sola vez, solo a dueños y administradores,
 * y que un correo fallido se reintente. Un aviso repetido cada 5 minutos sería spam; uno
 * perdido, una multa.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enviarAvisos, tramo, type Correo } from '../../src/avisos/avisos.js';
import type { Db } from '../../src/db/conexion.js';
import { asignarEmpresa, crearUsuario } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase } from './base-prueba.js';

describe('tramos de aviso', () => {
  it('el menor umbral alcanzado', () => {
    expect(tramo(10, [0, 3, 7])).toBeUndefined();
    expect(tramo(7, [0, 3, 7])).toBe(7);
    expect(tramo(5, [0, 3, 7])).toBe(7);
    expect(tramo(2, [0, 3, 7])).toBe(3);
    expect(tramo(0, [0, 3, 7])).toBe(0);
  });
});

describe.skipIf(!URL_PRUEBAS)('avisos por correo', () => {
  let db: Db;
  let empresaId: string;
  let enviados: Correo[];
  let correoDueno: string;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const enviar = async (c: Correo) => void enviados.push(c);
  let n = 0;

  beforeAll(async () => {
    db = await prepararBase();
  });
  beforeEach(async () => {
    enviados = [];
    // RUC terminado en 4: octubre 2026 vence el jueves 19/11/2026.
    let ruc = '';
    while (!ruc.endsWith('4')) {
      const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      ruc = base + digitoVerificadorRuc(base);
    }
    ({ empresaId } = await crearEmpresa(db, ruc));
    for (const rol of ['DUENO', 'VENDEDOR'] as const) {
      const email = `${rol.toLowerCase()}${++n}@prueba.pe`;
      if (rol === 'DUENO') correoDueno = email;
      const { usuarioId } = await crearUsuario(db, { email, nombre: rol, contrasena: 'clave del panel 2026', llaveMaestra });
      await asignarEmpresa(db, usuarioId, empresaId, rol);
    }
  });

  // Solo los correos de la empresa de esta prueba (las de pruebas anteriores también reciben).
  const deEsta = () => enviados.filter((c) => c.para.includes(correoDueno));

  it('vencimiento: 7 días antes, una sola vez aunque el cron corra muchas veces; solo al dueño', async () => {
    await enviarAvisos(db, enviar, '2026-11-01'); // faltan 18 días: nada
    expect(deEsta().filter((c) => c.asunto.includes('declarar'))).toHaveLength(0);
    await enviarAvisos(db, enviar, '2026-11-12');
    await enviarAvisos(db, enviar, '2026-11-12');
    await enviarAvisos(db, enviar, '2026-11-13');
    const avisos = deEsta().filter((c) => c.asunto.includes('declarar'));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.asunto).toContain('octubre 2026 vence en 7 días');
    expect(avisos[0]!.texto).toContain('jueves, 19 de noviembre de 2026');
    expect(avisos[0]!.para).toEqual([correoDueno]); // el vendedor no recibe
    await enviarAvisos(db, enviar, '2026-11-17'); // tramo de 3 días
    await enviarAvisos(db, enviar, '2026-11-19'); // el mismo día
    expect(deEsta().filter((c) => c.asunto.includes('declarar')).map((c) => c.asunto.split(' vence ')[1])).toEqual(['en 7 días', 'en 2 días', 'HOY']);
  });

  it('si el correo falla, se reintenta en la próxima pasada', async () => {
    const falla = async () => { throw new Error('sin conexión'); };
    expect(await enviarAvisos(db, falla, '2026-11-12')).toBe(0);
    await enviarAvisos(db, enviar, '2026-11-12');
    expect(deEsta().filter((c) => c.asunto.includes('declarar'))).toHaveLength(1);
  });

  it('alerta roja (comprobante rechazado): un correo por alerta', async () => {
    await db.query(`INSERT INTO alertas (empresa_id, tipo, severidad, mensaje) VALUES ($1, 'COMPROBANTE_RECHAZADO', 'ROJO', 'SUNAT rechazó B001-00000009.')`, [empresaId]);
    await enviarAvisos(db, enviar, '2026-11-01');
    await enviarAvisos(db, enviar, '2026-11-01');
    expect(deEsta().filter((c) => c.texto.includes('B001-00000009'))).toHaveLength(1);
  });

  it('la empresa puede apagar los avisos', async () => {
    await db.query(`UPDATE empresas SET modulos_desactivados = '{avisos}' WHERE id = $1`, [empresaId]);
    await enviarAvisos(db, enviar, '2026-11-12');
    expect(deEsta()).toHaveLength(0);
  });
});
