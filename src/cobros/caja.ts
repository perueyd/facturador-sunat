/**
 * Caja: cuánto dinero entró, a qué cuenta, y el total.
 *
 * Cada cobro dice a qué cuenta entró (el Yape de la empresa, el de una persona, efectivo…).
 * La caja muestra cada cuenta por separado, la suma de las cuentas de la empresa, la de las
 * cuentas de otras personas, y el total. Los cobros anulados no cuentan. Montos exactos
 * (NUMERIC), como texto.
 */
import { enTransaccion, type Db } from '../db/conexion.js';
import { dec } from '../dinero.js';
import { MEDIOS_PAGO, type MedioPago } from './pagos.js';

export class ErrorCuenta extends Error {}

export interface Cuenta {
  id: string;
  nombre: string;
  medio: MedioPago;
  titular: string | null;
  deLaEmpresa: boolean;
  predeterminada: boolean;
  activa: boolean;
}

export async function listarCuentas(db: Db, empresaId: string): Promise<Cuenta[]> {
  const r = await db.query(
    `SELECT id, nombre, medio::text AS medio, titular, de_la_empresa, predeterminada, activa FROM cuentas_cobro
      WHERE empresa_id = $1 ORDER BY activa DESC, de_la_empresa DESC, nombre`,
    [empresaId],
  );
  return r.rows.map((f) => ({ id: f.id, nombre: f.nombre, medio: f.medio, titular: f.titular, deLaEmpresa: f.de_la_empresa, predeterminada: f.predeterminada, activa: f.activa }));
}

/** Crea una cuenta o cambia una existente (por id). Ser predeterminada quita esa marca a la anterior del mismo medio. */
export async function guardarCuenta(
  db: Db,
  empresaId: string,
  c: { id?: string; nombre: string; medio: string; titular?: string; deLaEmpresa: boolean; predeterminada: boolean; activa?: boolean },
  usuarioId: string,
): Promise<string> {
  const nombre = c.nombre.trim();
  if (!nombre || nombre.length > 60) throw new ErrorCuenta('Ponle un nombre a la cuenta, por ejemplo "Yape de la empresa".');
  if (!MEDIOS_PAGO.includes(c.medio as MedioPago)) throw new ErrorCuenta('Elige el medio: Yape, Plin, efectivo, transferencia o tarjeta.');
  const activa = c.activa ?? true;
  const predeterminada = c.predeterminada && activa;
  try {
    if (predeterminada) {
      await db.query(`UPDATE cuentas_cobro SET predeterminada = false WHERE empresa_id = $1 AND medio = $2 AND ($3::uuid IS NULL OR id <> $3)`, [empresaId, c.medio, c.id ?? null]);
    }
    const r = c.id
      ? await db.query(
        // Un titular que no se manda se conserva (ej. al solo desactivar la cuenta).
        `UPDATE cuentas_cobro SET nombre = $3, medio = $4, titular = CASE WHEN $9 THEN $5 ELSE titular END, de_la_empresa = $6, predeterminada = $7, activa = $8
          WHERE id = $1 AND empresa_id = $2 RETURNING id`,
        [c.id, empresaId, nombre, c.medio, c.titular?.trim() || null, c.deLaEmpresa, predeterminada, activa, c.titular !== undefined],
      )
      : await db.query(
        `INSERT INTO cuentas_cobro (empresa_id, nombre, medio, titular, de_la_empresa, predeterminada) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [empresaId, nombre, c.medio, c.titular?.trim() || null, c.deLaEmpresa, predeterminada],
      );
    const id = r.rows[0]?.id as string | undefined;
    if (!id) throw new ErrorCuenta('Cuenta no encontrada.');
    await db.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'GUARDAR_CUENTA_COBRO', 'cuentas_cobro', $3, $4)`, [
      empresaId, usuarioId, id, JSON.stringify({ nombre, medio: c.medio, titular: c.titular ?? null, deLaEmpresa: c.deLaEmpresa, predeterminada, activa }),
    ]);
    return id;
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === '23505') throw new ErrorCuenta('Ya tienes una cuenta con ese nombre.');
    throw e;
  }
}

export interface FilaCaja {
  cuentaId: string | null;
  nombre: string;
  medio: string;
  titular: string | null;
  deLaEmpresa: boolean;
  cobros: number;
  /** Lo que entró (cobros). */
  monto: string;
  /** Lo que salió (gastos no anulados). */
  gastos: string;
  /** Lo que debería quedar: entró − salió. */
  neto: string;
}

export interface Caja {
  desde: string;
  hasta: string;
  cuentas: FilaCaja[];
  totales: { empresa: string; terceros: string; total: string; cobros: number; gastos: string; neto: string };
  /** Lo vendido en el período (boletas y facturas, menos notas de crédito), para comparar con lo cobrado. */
  vendido: string;
}

/** Caja de un período (fechas AAAA-MM-DD, ambas incluidas): por cuenta, lo que entró, lo que salió y lo que queda. */
export async function caja(db: Db, empresaId: string, desde: string, hasta: string): Promise<Caja> {
  const r = await db.query(
    `WITH mov AS (
       SELECT cuenta_id, medio, monto AS entra, 0::numeric AS sale, 1 AS es_cobro FROM pagos
        WHERE empresa_id = $1 AND anulado_en IS NULL AND fecha BETWEEN $2::date AND $3::date
       UNION ALL
       SELECT cuenta_id, medio, 0, monto, 0 FROM gastos
        WHERE empresa_id = $1 AND anulado_en IS NULL AND fecha BETWEEN $2::date AND $3::date)
     SELECT k.id AS cuenta_id, coalesce(k.nombre, 'Sin cuenta: ' || initcap(m.medio::text)) AS nombre, m.medio::text AS medio,
            k.titular, coalesce(k.de_la_empresa, true) AS de_la_empresa, sum(m.es_cobro)::int AS cobros,
            sum(m.entra)::text AS monto, sum(m.sale)::text AS gastos
       FROM mov m LEFT JOIN cuentas_cobro k ON k.id = m.cuenta_id
      GROUP BY k.id, m.medio ORDER BY sum(m.entra) DESC, sum(m.sale) DESC`,
    [empresaId, desde, hasta],
  );
  let empresa = dec('0');
  let terceros = dec('0');
  let gastos = dec('0');
  let cobros = 0;
  const cuentas = r.rows.map((f): FilaCaja => {
    const monto = dec(f.monto);
    const sale = dec(f.gastos);
    if (f.de_la_empresa) empresa = empresa.plus(monto);
    else terceros = terceros.plus(monto);
    gastos = gastos.plus(sale);
    cobros += f.cobros as number;
    return {
      cuentaId: f.cuenta_id, nombre: f.nombre, medio: f.medio, titular: f.titular, deLaEmpresa: f.de_la_empresa, cobros: f.cobros,
      monto: monto.toFixed(2), gastos: sale.toFixed(2), neto: monto.minus(sale).toFixed(2),
    };
  });
  const v = (await db.query(
    `SELECT coalesce(sum(CASE WHEN tipo_comprobante = '07' THEN -importe_total ELSE importe_total END), 0)::text AS total
       FROM comprobantes WHERE empresa_id = $1 AND estado NOT IN ('RECHAZADO', 'ANULADO') AND fecha_emision BETWEEN $2::date AND $3::date`,
    [empresaId, desde, hasta],
  )).rows[0];
  const total = empresa.plus(terceros);
  return {
    desde, hasta, cuentas,
    totales: { empresa: empresa.toFixed(2), terceros: terceros.toFixed(2), total: total.toFixed(2), cobros, gastos: gastos.toFixed(2), neto: total.minus(gastos).toFixed(2) },
    vendido: dec(v.total).toFixed(2),
  };
}

// ---------- Cierre de caja diario ----------

export interface LineaCierre {
  /** Identifica la línea al contar: el id de la cuenta, o "SIN:EFECTIVO" para cobros sin cuenta. */
  clave: string;
  cuentaId: string | null;
  medio: string;
  nombre: string;
  esperado: string;
}

export interface Cierre {
  id: string;
  fecha: string;
  cerradoPor: string;
  cerradoEn: string;
  nota: string | null;
  lineas: (LineaCierre & { contado: string; diferencia: string })[];
  totales: { esperado: string; contado: string; diferencia: string };
}

const claveDe = (cuentaId: string | null, medio: string) => cuentaId ?? `SIN:${medio}`;

/**
 * Lo que debería haber en cada cuenta al final del día: cobros menos gastos registrados.
 * Incluye las cuentas activas sin cobros (ej. el cajón de efectivo con S/ 0), porque
 * también se cuentan: un faltante o sobrante ahí es igual de importante.
 */
export async function lineasParaCerrar(db: Db, empresaId: string, fecha: string): Promise<LineaCierre[]> {
  const c = await caja(db, empresaId, fecha, fecha);
  const lineas: LineaCierre[] = c.cuentas.map((x) => ({ clave: claveDe(x.cuentaId, x.medio), cuentaId: x.cuentaId, medio: x.medio, nombre: x.nombre, esperado: x.neto }));
  for (const k of await listarCuentas(db, empresaId)) {
    if (k.activa && !lineas.some((l) => l.cuentaId === k.id)) lineas.push({ clave: k.id, cuentaId: k.id, medio: k.medio, nombre: k.nombre, esperado: '0.00' });
  }
  return lineas;
}

/**
 * Cierra la caja de un día con lo contado en cada cuenta. Lo esperado lo calcula el servidor
 * (nunca lo manda el navegador). Se puede cerrar otra vez el mismo día: vale el último cierre.
 */
export async function cerrarCaja(
  db: Db,
  empresaId: string,
  fecha: string,
  contados: Record<string, string>,
  nota: string | null,
  usuarioId: string,
  hoy: string,
): Promise<Cierre> {
  if (fecha > hoy) throw new ErrorCuenta('No se puede cerrar la caja de un día que aún no llega.');
  const lineas = await lineasParaCerrar(db, empresaId, fecha);
  if (!lineas.length) throw new ErrorCuenta('No hay cobros ni cuentas que contar ese día.');
  const faltan = lineas.filter((l) => contados[l.clave] === undefined).map((l) => l.nombre);
  if (faltan.length) throw new ErrorCuenta(`Falta poner cuánto contaste en: ${faltan.join(', ')}.`);
  for (const l of lineas) {
    if (!/^\d{1,11}(\.\d{1,2})?$/.test(contados[l.clave] ?? '')) throw new ErrorCuenta(`"${l.nombre}": escribe el monto contado, por ejemplo 150.00.`);
  }
  const id = await enTransaccion(db, async (tx) => {
    const nuevo = (await tx.query(
      `INSERT INTO cierres_caja (empresa_id, fecha, usuario_id, nota) VALUES ($1, $2, $3, $4) RETURNING id`,
      [empresaId, fecha, usuarioId, nota?.trim() || null],
    )).rows[0].id as string;
    for (const [i, l] of lineas.entries()) {
      await tx.query(
        `INSERT INTO cierre_caja_lineas (cierre_id, linea, cuenta_id, medio, nombre, esperado, contado) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [nuevo, i + 1, l.cuentaId, l.medio, l.nombre, l.esperado, contados[l.clave]],
      );
    }
    await tx.query(`INSERT INTO auditoria (empresa_id, usuario_id, accion, entidad, entidad_id, despues) VALUES ($1, $2, 'CERRAR_CAJA', 'cierres_caja', $3, $4)`, [
      empresaId, usuarioId, nuevo, JSON.stringify({ fecha, contados }),
    ]);
    return nuevo;
  });
  const cierre = (await cierresDeCaja(db, empresaId, fecha, fecha)).find((x) => x.id === id);
  if (!cierre) throw new Error('El cierre recién guardado no se encontró.');
  return cierre;
}

/** Los cierres de un período, el más reciente primero (incluye los reemplazados del mismo día). */
export async function cierresDeCaja(db: Db, empresaId: string, desde: string, hasta: string): Promise<Cierre[]> {
  const r = await db.query(
    `SELECT k.id, k.fecha::text AS fecha, coalesce(u.nombre, u.email) AS cerrado_por, k.creado_en, k.nota,
            json_agg(json_build_object('cuentaId', l.cuenta_id, 'medio', l.medio, 'nombre', l.nombre, 'esperado', l.esperado::text, 'contado', l.contado::text) ORDER BY l.linea) AS lineas
       FROM cierres_caja k JOIN usuarios u ON u.id = k.usuario_id JOIN cierre_caja_lineas l ON l.cierre_id = k.id
      WHERE k.empresa_id = $1 AND k.fecha BETWEEN $2::date AND $3::date
      GROUP BY k.id, u.id ORDER BY k.fecha DESC, k.creado_en DESC`,
    [empresaId, desde, hasta],
  );
  return r.rows.map((f): Cierre => {
    let esperado = dec('0');
    let contado = dec('0');
    const lineas = (f.lineas as { cuentaId: string | null; medio: string; nombre: string; esperado: string; contado: string }[]).map((l) => {
      const e = dec(l.esperado);
      const k = dec(l.contado);
      esperado = esperado.plus(e);
      contado = contado.plus(k);
      return { clave: claveDe(l.cuentaId, l.medio), cuentaId: l.cuentaId, medio: l.medio, nombre: l.nombre, esperado: e.toFixed(2), contado: k.toFixed(2), diferencia: k.minus(e).toFixed(2) };
    });
    return {
      id: f.id, fecha: f.fecha, cerradoPor: f.cerrado_por, cerradoEn: new Date(f.creado_en).toISOString(), nota: f.nota, lineas,
      totales: { esperado: esperado.toFixed(2), contado: contado.toFixed(2), diferencia: contado.minus(esperado).toFixed(2) },
    };
  });
}
