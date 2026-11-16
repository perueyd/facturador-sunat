/**
 * Reiniciar los datos de PRUEBA de una empresa (pedido del dueño, 16/11/2026).
 *
 * La regla del proyecto es "nunca borrar comprobantes". Estas pruebas vigilan que el reinicio
 * no la rompa: solo en BETA, nunca con comprobantes de producción, siempre con copia, sin
 * tocar a otra empresa, y con los candados de siempre funcionando fuera del reinicio.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearAlerta } from '../../src/alertas.js';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { registrarGasto } from '../../src/cobros/gastos.js';
import { registrarPago } from '../../src/cobros/pagos.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import { crearCotizacion } from '../../src/cotizaciones/cotizaciones.js';
import { enTransaccion, type Db } from '../../src/db/conexion.js';
import { ErrorReinicio, estadoReinicio, reiniciar, restaurarCopia } from '../../src/empresas/reinicio.js';
import { ahoraLima } from '../../src/fechas.js';
import { registrarCompra } from '../../src/inventario/compras.js';
import { ajustarStock, guardarProducto, listarStock } from '../../src/inventario/productos.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { RUC_CLIENTE, RUC_PERSONA, item, solicitudBoleta, solicitudFactura } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

/**
 * Tablas que el reinicio NO toca. Toda tabla de la base tiene que estar aquí o en
 * `reinicio_plan()`: si agregas una tabla, decide a propósito si se reinicia o se conserva.
 */
const SE_CONSERVAN = [
  // La empresa y su configuración
  'empresas', 'empresa_regimen', 'empresa_exoneraciones', 'series', 'marcas', 'canales', 'certificados', 'credenciales_sol',
  'api_llaves', 'cuentas_cobro', 'metas', 'productos', 'proveedores',
  // Documentos reales de antes de este facturador y lo que el dueño declaró
  'comprobantes_antiguos', 'declaraciones_mensuales',
  // Personas, accesos e historial de acciones
  'usuarios', 'usuario_empresa', 'sesiones', 'invitaciones', 'codigos_respaldo', 'recuperaciones_correo', 'auditoria', 'avisos_enviados', 'reportes',
  // La plataforma (planes, cobros del servicio, aliados)
  'planes', 'suscripciones', 'pagos_suscripcion', 'aliados', 'pagos_aliado', 'avisos_plataforma', 'errores_plataforma',
  // Catálogos y parámetros
  'parametros_tributarios', 'cronograma_mensual', 'exoneraciones', 'regimen_comprobantes_permitidos', 'sunat_errores', 'migraciones_aplicadas',
  // Las propias copias
  'reinicios', 'reinicio_filas',
];

describe.skipIf(!URL_PRUEBAS)('reiniciar datos de prueba', () => {
  let db: Db;
  let a: Fixture;
  let b: Fixture;
  let usuarioId: string;
  let app: ReturnType<typeof crearApp>;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const hoy = ahoraLima().fecha;

  /** Todo lo que el reinicio puede tocar de una empresa, tal cual está guardado. */
  const foto = async (empresaId: string, grupos = ['VENTAS', 'CLIENTES', 'COMPRAS']) => {
    const plan = await db.query(`SELECT orden, tabla, filtro FROM reinicio_plan() WHERE grupo = ANY($1) ORDER BY orden`, [grupos]);
    const todo: Record<string, unknown[]> = {};
    for (const p of plan.rows) {
      const r = await db.query(`SELECT to_jsonb(t) AS fila FROM ${p.tabla} t WHERE ${p.filtro} ORDER BY to_jsonb(t)::text`, [empresaId]);
      todo[`${p.orden} ${p.tabla}`] = r.rows.map((x) => x.fila);
    }
    return todo;
  };
  const cuantos = async (tabla: string, empresaId: string) =>
    (await db.query(`SELECT count(*)::int AS n FROM ${tabla} WHERE empresa_id = $1`, [empresaId])).rows[0].n as number;
  const numeroDe = async (empresaId: string, serie: string) =>
    Number((await db.query(`SELECT ultimo_numero FROM series WHERE empresa_id = $1 AND serie = $2`, [empresaId, serie])).rows[0].ultimo_numero);

  /** Una empresa con un poco de todo: ventas cobradas, cotización, compra, gasto, stock, archivos y alertas. */
  async function llenar(f: Fixture) {
    await guardarProducto(db, f.empresaId, { sku: 'TAR-001', nombre: 'Tarima', precio: '350.00', controlaStock: true });
    await registrarCompra(db, f.empresaId, {
      proveedor: { ruc: RUC_PERSONA, razonSocial: 'PROVEEDOR DE MELAMINA' }, serie: 'F001', numero: 7, fecha: hoy,
      igv: '180.00', total: '1180.00', items: [{ sku: 'TAR-001', descripcion: 'Tarima', cantidad: '10', costoUnitario: '100.00' }],
    });
    await ajustarStock(db, f.empresaId, 'TAR-001', '2', 'Conteo inicial', usuarioId);
    await registrarGasto(db, f.empresaId, { fecha: hoy, monto: '25', categoria: 'TRANSPORTE', descripcion: 'Taxi', medio: 'EFECTIVO' }, usuarioId, hoy);

    const boleta = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy, items: [item('350.00', '3')] }) });
    const factura = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalManual, solicitud: solicitudFactura({ fechaEmision: hoy }) });
    if (boleta.resultado === 'ERROR_VALIDACION' || factura.resultado === 'ERROR_VALIDACION') throw new Error('No se pudo emitir.');
    await registrarPago(db, { empresaId: f.empresaId, comprobanteId: boleta.guardado.id, medio: 'YAPE', monto: '100.00', referencia: 'OP-1', usuarioId });
    await crearCotizacion(db, f.empresaId, {
      cliente: { tipoDocumento: 'RUC', numero: RUC_CLIENTE, nombre: 'CLIENTE S.A.C.' }, diasValidez: 7,
      items: [{ descripcion: 'Cabecera', cantidad: '1', precio: '500.00' }],
    }, usuarioId, hoy);
    await crearAlerta(db, { empresaId: f.empresaId, tipo: 'PRUEBA', severidad: 'AMARILLO', mensaje: 'Alerta de prueba', entidad: 'comprobantes', entidadId: boleta.guardado.id });
    // XML firmado y envío a SUNAT beta (aquí puestos a mano: firmar pide certificado), más el logo, que NO se reinicia.
    const ruc = (await db.query(`SELECT ruc FROM empresas WHERE id = $1`, [f.empresaId])).rows[0].ruc as string;
    for (const [entidad, entidadId, tipo, ruta] of [
      ['comprobantes', boleta.guardado.id, 'XML_FIRMADO', `${ruc}/2026/11/boleta.xml`],
      ['empresas', f.empresaId, 'LOGO', `${ruc}/logo/logo.png`],
    ] as const) {
      await db.query(`INSERT INTO archivos_contenido (ruta, contenido, sha256) VALUES ($1, $2, $3)`, [ruta, Buffer.from(`contenido de ${ruta}`), 'a'.repeat(64)]);
      await db.query(
        `INSERT INTO archivos (empresa_id, entidad, entidad_id, tipo, ruta_almacenamiento, sha256, tamano, conservar_hasta) VALUES ($1, $2, $3, $4, $5, $6, 10, current_date + 2000)`,
        [f.empresaId, entidad, entidadId, tipo, ruta, 'a'.repeat(64)],
      );
    }
    await db.query(`INSERT INTO envios_sunat (empresa_id, tipo, referencia_id, metodo, ambiente, codigo_respuesta) VALUES ($1, 'COMPROBANTE', $2, 'sendBill', 'BETA', '0')`, [f.empresaId, boleta.guardado.id]);
    return { boletaId: boleta.guardado.id };
  }

  beforeAll(async () => {
    db = await prepararBase();
    a = await crearEmpresa(db);
    b = await crearEmpresa(db, RUC_CLIENTE);
    usuarioId = (await db.query(`INSERT INTO usuarios (email, nombre) VALUES ('reinicio@prueba.pe', 'Dueño') RETURNING id`)).rows[0].id;
    await llenar(a);
    await llenar(b);
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-reinicio-')));
    app = crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } });
    panel = panelDePrueba(app, db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('toda tabla está clasificada: o se reinicia o se conserva', async () => {
    const tablas = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name as string);
    const plan = (await db.query(`SELECT DISTINCT tabla FROM reinicio_plan()`)).rows.map((r) => r.tabla as string);
    expect([...plan, ...SE_CONSERVAN].sort()).toEqual(tablas.sort());
    expect(plan.filter((t) => SE_CONSERVAN.includes(t))).toEqual([]);
  });

  it('fuera de un reinicio, los candados siguen igual', async () => {
    await expect(db.query(`DELETE FROM comprobantes WHERE empresa_id = $1`, [a.empresaId])).rejects.toThrow(/No se permite borrar/);
    await expect(db.query(`DELETE FROM movimientos_stock WHERE empresa_id = $1`, [a.empresaId])).rejects.toThrow(/solo inserción/);
    await expect(db.query(`UPDATE series SET ultimo_numero = 0 WHERE empresa_id = $1`, [a.empresaId])).rejects.toThrow(/no puede retroceder/);
    // Ni poniendo la marca a mano se puede borrar lo que el reinicio no toca, ni lo de OTRA empresa.
    await expect(enTransaccion(db, async (tx) => {
      await tx.query(`SELECT set_config('facturador.reinicio', $1, true)`, [a.empresaId]);
      await tx.query(`DELETE FROM series WHERE empresa_id = $1`, [a.empresaId]);
    })).rejects.toThrow(/No se permite borrar/);
    await expect(enTransaccion(db, async (tx) => {
      await tx.query(`SELECT set_config('facturador.reinicio', $1, true)`, [a.empresaId]);
      await tx.query(`DELETE FROM auditoria WHERE empresa_id = $1`, [a.empresaId]);
    })).rejects.toThrow(/solo inserción/);
    await expect(enTransaccion(db, async (tx) => {
      await tx.query(`SELECT set_config('facturador.reinicio', $1, true)`, [a.empresaId]);
      await tx.query(`DELETE FROM comprobantes WHERE empresa_id = $1`, [b.empresaId]);
    })).rejects.toThrow(/No se permite borrar/);
    // Y modificar sigue prohibido incluso con la marca: el reinicio solo quita, nunca altera.
    await expect(enTransaccion(db, async (tx) => {
      await tx.query(`SELECT set_config('facturador.reinicio', $1, true)`, [a.empresaId]);
      await tx.query(`UPDATE envios_sunat SET mensaje = 'x' WHERE empresa_id = $1`, [a.empresaId]);
    })).rejects.toThrow(/solo inserción/);
  });

  it('quita ventas y clientes, guarda la copia, vuelve la numeración a 1 y no toca compras, stock comprado ni a la otra empresa', async () => {
    const antesB = await foto(b.empresaId);
    const estado = await estadoReinicio(db, a.empresaId);
    expect(estado.bloqueo).toBeNull();
    expect(estado.hay.VENTAS).toMatchObject({ comprobantes: 2, pagos: 1, cotizaciones: 1, alertas: expect.any(Number), archivos: 1 });
    expect(estado.hay.CLIENTES.clientes).toBeGreaterThan(0);
    expect(estado.hay.COMPRAS).toMatchObject({ compras: 1, gastos: 1, movimientos_stock: 2 });
    expect(await numeroDe(a.empresaId, 'B001')).toBe(1);

    const copia = await reiniciar(db, { empresaId: a.empresaId, usuarioId, grupos: ['VENTAS', 'CLIENTES'] });

    for (const t of ['comprobantes', 'pagos', 'cotizaciones', 'clientes', 'envios_sunat', 'alertas', 'cola_envios']) expect(await cuantos(t, a.empresaId), t).toBe(0);
    expect(Object.values(await foto(a.empresaId, ['VENTAS', 'CLIENTES'])).flat()).toEqual([]);
    // Se queda: compras, gastos, el stock que entró (10 comprados + 2 del conteo; las 3 vendidas ya no descuentan), productos, series y el logo.
    expect(await cuantos('compras', a.empresaId)).toBe(1);
    expect(await cuantos('gastos', a.empresaId)).toBe(1);
    expect((await listarStock(db, a.empresaId)).find((p) => p.sku === 'TAR-001')?.stock).toBe('12');
    expect(await cuantos('series', a.empresaId)).toBeGreaterThan(3);
    expect((await db.query(`SELECT tipo FROM archivos WHERE empresa_id = $1`, [a.empresaId])).rows).toEqual([{ tipo: 'LOGO' }]);
    expect((await db.query(`SELECT count(*)::int AS n FROM archivos_contenido WHERE ruta LIKE '%/logo/logo.png'`)).rows[0].n).toBe(2);
    expect(await numeroDe(a.empresaId, 'B001')).toBe(0);
    // La otra empresa, intacta.
    expect(await foto(b.empresaId)).toEqual(antesB);
    expect(await numeroDe(b.empresaId, 'B001')).toBe(1);

    // La copia tiene lo que se quitó y quedó anotado quién y cuándo.
    const c = (await estadoReinicio(db, a.empresaId)).copias;
    expect(c).toEqual([expect.objectContaining({ id: copia, motivo: 'REINICIO', grupos: ['VENTAS', 'CLIENTES'], quien: 'Dueño' })]);
    expect(c[0]!.filas).toMatchObject({ comprobantes: 2, pagos: 1, cotizaciones: 1, archivos: 1, archivos_contenido: 1 });
    expect((await db.query(`SELECT accion, usuario_id FROM auditoria WHERE empresa_id = $1 AND entidad = 'reinicios'`, [a.empresaId])).rows)
      .toEqual([{ accion: 'REINICIAR_DATOS_DE_PRUEBA', usuario_id: usuarioId }]);

    // Lo siguiente que se emite vuelve a ser el número 1.
    const nueva = await emitirComprobante(db, { empresaId: a.empresaId, canalId: a.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy }) });
    if (nueva.resultado === 'ERROR_VALIDACION') throw new Error(nueva.errores.join('; '));
    expect(nueva.guardado.comprobante.numero).toBe(1);
  });

  it('restaurar devuelve todo exactamente como estaba y aparta lo que había en otra copia', async () => {
    const antes = await foto(b.empresaId);
    const numeros = (await db.query(`SELECT serie, ultimo_numero FROM series WHERE empresa_id = $1 ORDER BY serie`, [b.empresaId])).rows;
    const copia = await reiniciar(db, { empresaId: b.empresaId, usuarioId, grupos: ['VENTAS', 'CLIENTES', 'COMPRAS'] });
    expect(Object.values(await foto(b.empresaId)).flat()).toEqual([]);
    expect((await listarStock(db, b.empresaId)).find((p) => p.sku === 'TAR-001')?.stock).toBe('0');
    expect(await cuantos('productos', b.empresaId)).toBe(1);
    expect(await cuantos('proveedores', b.empresaId)).toBe(1);

    // Entre medias se emite algo nuevo (vuelve a ser la B001-1): al restaurar no puede chocar ni perderse.
    const nueva = await emitirComprobante(db, { empresaId: b.empresaId, canalId: b.canalManual, solicitud: solicitudBoleta({ fechaEmision: hoy }) });
    if (nueva.resultado === 'ERROR_VALIDACION') throw new Error(nueva.errores.join('; '));

    const previa = await restaurarCopia(db, { empresaId: b.empresaId, usuarioId, copiaId: copia });
    expect(await foto(b.empresaId)).toEqual(antes);
    expect((await db.query(`SELECT serie, ultimo_numero FROM series WHERE empresa_id = $1 ORDER BY serie`, [b.empresaId])).rows).toEqual(numeros);
    // La copia restaurada ya no está en la lista; queda la de "lo que había", con la boleta nueva dentro.
    const copias = (await estadoReinicio(db, b.empresaId)).copias;
    expect(copias).toEqual([expect.objectContaining({ id: previa, motivo: 'ANTES_DE_RESTAURAR' })]);
    expect(copias[0]!.filas.comprobantes).toBe(1);
    await expect(restaurarCopia(db, { empresaId: b.empresaId, usuarioId, copiaId: copia })).rejects.toThrow(ErrorReinicio);
    // Una copia de otra empresa no se puede restaurar aquí.
    await expect(restaurarCopia(db, { empresaId: a.empresaId, usuarioId, copiaId: previa })).rejects.toThrow(/ya no existe/);
    // Y lo restaurado sigue protegido como siempre.
    await expect(db.query(`DELETE FROM comprobantes WHERE empresa_id = $1`, [b.empresaId])).rejects.toThrow(/No se permite borrar/);
  });

  it('se conservan solo las 3 últimas copias', async () => {
    for (let i = 0; i < 4; i++) await reiniciar(db, { empresaId: b.empresaId, usuarioId, grupos: ['VENTAS'] });
    expect((await estadoReinicio(db, b.empresaId)).copias).toHaveLength(3);
    expect((await db.query(`SELECT count(DISTINCT reinicio_id)::int AS n FROM reinicio_filas f JOIN reinicios r ON r.id = f.reinicio_id WHERE r.empresa_id = $1`, [b.empresaId])).rows[0].n).toBeLessThanOrEqual(3);
  });

  it('en producción es imposible: ni por la función, ni con la marca puesta a mano, ni restaurando', async () => {
    const c = await crearEmpresa(db, RUC_PERSONA);
    const { boletaId } = await llenar(c);
    const copia = await reiniciar(db, { empresaId: c.empresaId, usuarioId, grupos: ['VENTAS'] });
    await restaurarCopia(db, { empresaId: c.empresaId, usuarioId, copiaId: copia });
    const [guardada] = (await estadoReinicio(db, c.empresaId)).copias;
    const antes = await foto(c.empresaId);

    // Un solo envío real a SUNAT ya lo impide, aunque la empresa siga marcada como beta.
    await db.query(`INSERT INTO envios_sunat (empresa_id, tipo, referencia_id, metodo, ambiente) VALUES ($1, 'COMPROBANTE', $2, 'sendBill', 'PRODUCCION')`, [c.empresaId, boletaId]);
    await expect(reiniciar(db, { empresaId: c.empresaId, usuarioId, grupos: ['VENTAS'] })).rejects.toThrow(/comprobantes reales/);

    await db.query(`UPDATE empresas SET ambiente_sunat = 'PRODUCCION', produccion_autorizada_por = $2, produccion_autorizada_en = now() WHERE id = $1`, [c.empresaId, usuarioId]);
    expect((await estadoReinicio(db, c.empresaId)).bloqueo).toMatch(/producción/);
    await expect(reiniciar(db, { empresaId: c.empresaId, usuarioId, grupos: ['VENTAS', 'CLIENTES', 'COMPRAS'] })).rejects.toThrow(ErrorReinicio);
    await expect(restaurarCopia(db, { empresaId: c.empresaId, usuarioId, copiaId: guardada!.id })).rejects.toThrow(ErrorReinicio);
    await expect(enTransaccion(db, async (tx) => {
      await tx.query(`SELECT set_config('facturador.reinicio', $1, true)`, [c.empresaId]);
      await tx.query(`DELETE FROM comprobante_items WHERE comprobante_id = $1`, [boletaId]);
    })).rejects.toThrow(/No se permite borrar/);
    await expect(enTransaccion(db, async (tx) => {
      await tx.query(`SELECT set_config('facturador.reinicio', $1, true)`, [c.empresaId]);
      await tx.query(`UPDATE series SET ultimo_numero = 0 WHERE empresa_id = $1`, [c.empresaId]);
    })).rejects.toThrow(/no puede retroceder/);
    const despues = await foto(c.empresaId);
    delete antes['50 envios_sunat'];
    delete despues['50 envios_sunat'];
    expect(despues).toEqual(antes);
  });

  it('en el panel: solo el dueño, con la palabra y la contraseña', async () => {
    const dueno = await panel.entrar(a.empresaId, 'DUENO');
    const admin = await panel.entrar(a.empresaId, 'ADMIN');
    const bien = { confirmar: 'REINICIAR', contrasena: 'clave del panel 2026', grupos: ['VENTAS'] };
    expect((await panel.pedir('/panel/api/reinicio', { cookie: admin })).status).toBe(403);
    expect((await panel.pedir('/panel/api/reinicio', { cookie: admin, cuerpo: bien })).status).toBe(403);
    expect((await panel.pedir('/panel/api/reinicio', { cuerpo: bien })).status).toBe(401);

    const estado = await (await panel.pedir('/panel/api/reinicio', { cookie: dueno })).json();
    expect(estado.bloqueo).toBeNull();
    expect(estado.hay.VENTAS.comprobantes).toBe(1);
    expect((await panel.pedir('/panel/api/reinicio', { cookie: dueno, cuerpo: { ...bien, confirmar: 'reiniciar' } })).status).toBe(422);
    expect((await panel.pedir('/panel/api/reinicio', { cookie: dueno, cuerpo: { ...bien, contrasena: 'otra clave 12345' } })).status).toBe(422);
    expect(await cuantos('comprobantes', a.empresaId)).toBe(1);

    const r = await panel.pedir('/panel/api/reinicio', { cookie: dueno, cuerpo: bien });
    expect(r.status).toBe(200);
    const hecho = await r.json();
    expect(hecho.hay.VENTAS.comprobantes).toBe(0);
    expect(hecho.copias[0]).toMatchObject({ id: hecho.copia, motivo: 'REINICIO' });
    expect(await cuantos('comprobantes', a.empresaId)).toBe(0);

    // Restaurar pide su propia palabra.
    expect((await panel.pedir('/panel/api/reinicio', { cookie: dueno, cuerpo: { ...bien, restaurar: hecho.copia } })).status).toBe(422);
    const vuelta = await panel.pedir('/panel/api/reinicio', { cookie: dueno, cuerpo: { confirmar: 'RESTAURAR', contrasena: bien.contrasena, restaurar: hecho.copia } });
    expect(vuelta.status).toBe(200);
    expect(await cuantos('comprobantes', a.empresaId)).toBe(1);
  });
});
