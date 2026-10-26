import { createInterface } from 'node:readline';
import type { Db } from '../../src/db/conexion.js';

/** Lo escrito hasta ahora y si ya se pulsó Enter (o Ctrl+C). */
interface Tecleo {
  texto: string;
  fin?: 'enter' | 'cancelar';
}

/**
 * Aplica lo que llegó del teclado. Devuelve el estado nuevo y qué mostrar: un `*` por
 * letra, para que se note que sí se está escribiendo (sin nada visible, en Windows
 * parecía que el programa se había colgado).
 */
export function teclear(antes: Tecleo, trozo: string): { estado: Tecleo; eco: string } {
  let texto = antes.texto;
  let eco = '';
  // Flechas, Inicio, Supr…: llegan como secuencias de escape y no son parte de la clave.
  for (const c of trozo.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, '')) {
    if (c === '\r' || c === '\n') return { estado: { texto, fin: 'enter' }, eco };
    if (c === '\u0003') return { estado: { texto, fin: 'cancelar' }, eco };
    if (c === '\u007f' || c === '\b') {
      if (texto) eco += '\b \b';
      texto = [...texto].slice(0, -1).join('');
    } else if (c >= ' ') {
      texto += c;
      eco += '*';
    }
  }
  return { estado: { texto }, eco };
}

/**
 * Pide un dato por teclado sin mostrarlo (para contraseñas).
 *
 * Se lee tecla por tecla en modo "crudo" y no con readline: en la consola de Windows,
 * readline redibujaba la línea y borraba la pregunta, y el dueño no sabía que debía
 * escribir la contraseña.
 */
export function pedirOculto(pregunta: string): Promise<string> {
  if (process.env.CLAVE_PFX !== undefined) return Promise.resolve(process.env.CLAVE_PFX); // solo para automatizar
  const entrada = process.stdin;
  process.stdout.write(pregunta);
  if (!entrada.isTTY) {
    // Entrada redirigida (no es un teclado): se lee la primera línea tal cual.
    return new Promise((ok) => {
      const rl = createInterface({ input: entrada });
      rl.once('line', (linea) => {
        rl.close();
        ok(linea);
      });
    });
  }
  return new Promise((ok, falla) => {
    let estado: Tecleo = { texto: '' };
    const alTeclear = (trozo: string) => {
      const r = teclear(estado, trozo);
      estado = r.estado;
      process.stdout.write(r.eco);
      if (!estado.fin) return;
      entrada.off('data', alTeclear);
      entrada.setRawMode(false);
      entrada.pause();
      process.stdout.write('\n');
      if (estado.fin === 'enter') ok(estado.texto);
      else falla(new Error('Cancelado.'));
    };
    entrada.setRawMode(true);
    entrada.setEncoding('utf8');
    entrada.on('data', alTeclear);
    entrada.resume();
  });
}

/** Empresa por su RUC, o un error claro si no existe. */
export async function empresaPorRuc(db: Db, ruc: string | undefined): Promise<{ id: string; razonSocial: string }> {
  const r = await db.query(`SELECT id, razon_social FROM empresas WHERE ruc = $1`, [ruc ?? '']);
  if (!r.rows[0]) throw new Error(`No existe la empresa ${ruc}. Créala con npm run empresa:configurar.`);
  return { id: r.rows[0].id, razonSocial: r.rows[0].razon_social };
}
