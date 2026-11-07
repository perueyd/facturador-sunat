/**
 * Vender sin internet: boletas impresas de contingencia que el celular manda al volver la
 * señal, y el archivo RF para informarlas a SUNAT dentro de 7 días (R.S. 113-2018).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import { diasDeContingencia, generarInforme, registrarContingencia } from '../../src/contingencia/contingencia.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima, sumarDias } from '../../src/fechas.js';
import type { Rol } from '../../src/panel/usuarios.js';
import { tablero } from '../../src/reportes/tablero.js';
import { estadisticas } from '../../src/reportes/estadisticas.js';
import { caja } from '../../src/cobros/caja.js';
import { ajustarStock, guardarProducto, listarStock } from '../../src/inventario/productos.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { RUC_CLIENTE, RUC_EMPRESA } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

const hoy = ahoraLima().fecha;
let n = 0;
const venta = (extra: Record<string, unknown> = {}, k: Record<string, unknown> = {}) => ({
  tipo: 'BOLETA',
  cliente: { tipoDocumento: 'DNI', numero: '12345678', nombre: 'JUAN PÉREZ' },
  items: [{ descripcion: 'Tarima 2 plazas', cantidad: 1, precio: '350.00' }],
  pago: { medio: 'EFECTIVO' },
  ...extra,
  contingencia: { origen: `SINRED-prueba-${++n}`, serie: '0001', numero: n, fecha: hoy, hora: '10:15', anotadoEn: new Date().toISOString(), ...k },
});

describe.skipIf(!URL_PRUEBAS)('vender sin internet (contingencia)', () => {
  let db: Db;
  let f: Fixture;
  let almacen: AlmacenLocal;
  let app: ReturnType<typeof crearApp>;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-contingencia-')));
    app = crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } });
    panel = panelDePrueba(app, db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  const registrar = (cuerpo: Record<string, unknown>) => registrarContingencia(db, { empresaId: f.empresaId, cuerpo });

  it('calcula IGV y total igual que una boleta electrónica; llegar dos veces no duplica', async () => {
    const cuerpo = venta();
    const r = await registrar(cuerpo);
    expect(r).toMatchObject({ resultado: 'REGISTRADA', venta: { tipo: '03', comprobante: `0001-${n}`, total: '350.00', fechaEmision: hoy } });
    const fila = (await db.query(`SELECT total_gravado::text, total_igv::text, medio_pago FROM ventas_contingencia WHERE id = $1`, [r.venta.id])).rows[0];
    expect(fila).toEqual({ total_gravado: '296.61', total_igv: '53.39', medio_pago: 'EFECTIVO' });
    // Se cortó la señal al enviarla y el celular la manda otra vez: misma venta.
    expect(await registrar(cuerpo)).toMatchObject({ resultado: 'REPETIDA', venta: { id: r.venta.id } });
    // Solo inserción.
    await expect(db.query(`UPDATE ventas_contingencia SET importe_total = 1`)).rejects.toThrow();
  });

  it('valida como el facturador: número repetido, serie impresa, fecha, factura sin RUC, crédito', async () => {
    await registrar(venta({}, { serie: '0002', numero: 50 }));
    await expect(registrar(venta({}, { serie: '0002', numero: 50 }))).rejects.toThrow(/0002-50 ya está registrada/);
    await expect(registrar(venta({}, { serie: 'B001' }))).rejects.toThrow(/4 números/);
    await expect(registrar(venta({}, { fecha: sumarDias(hoy, 1) }))).rejects.toThrow(/fecha de la venta no es válida/);
    await expect(registrar(venta({ tipo: 'FACTURA' }))).rejects.toThrow(/RUC/);
    await expect(registrar(venta({ tipo: 'FACTURA', cliente: { tipoDocumento: 'RUC', numero: RUC_CLIENTE, nombre: 'CLIENTE S.A.C.' }, formaPago: { cuotas: [{ monto: '350.00', vence: sumarDias(hoy, 30) }] } })))
      .rejects.toThrow(/al contado/);
    await expect(registrar(venta({ tipo: 'NOTA_CREDITO' }))).rejects.toThrow();
  });

  it('archivo RF para SUNAT: nombre, una línea por comprobante con sus 26 campos; el siguiente lleva todo el día', async () => {
    const fecha = sumarDias(hoy, -2);
    await registrar(venta({}, { fecha, serie: '0003', numero: 1 }));
    await registrar(venta({ tipo: 'FACTURA', cliente: { tipoDocumento: 'RUC', numero: RUC_CLIENTE, nombre: 'CLIENTE | EMPRESA S.A.C.' }, items: [{ descripcion: 'Cabecera', cantidad: 2, precio: '590.00' }] },
      { fecha, serie: '0004', numero: 7 }));
    const dia = () => diasDeContingencia(db, f.empresaId).then((x) => x.find((d) => d.fecha === fecha)!);
    expect(await dia()).toMatchObject({ total: '1530.00', informado: false, vence: sumarDias(fecha, 7), diasRestantes: 5 });

    const ddmmaaaa = `${fecha.slice(8, 10)}${fecha.slice(5, 7)}${fecha.slice(0, 4)}`;
    const r = await generarInforme(db, almacen, { empresaId: f.empresaId, fecha });
    expect(r.nombre).toBe(`${RUC_EMPRESA}-RF-${ddmmaaaa}-01.ZIP`);
    const archivos = unzipSync(new Uint8Array(r.zip));
    expect(Object.keys(archivos)).toEqual([`${RUC_EMPRESA}-RF-${ddmmaaaa}-01.TXT`]);
    const lineas = strFromU8(Object.values(archivos)[0]!).trimEnd().split('\r\n');
    const fechaSunat = `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}`;
    expect(lineas).toEqual([
      `1|01|${fechaSunat}|01|0004|7||6|${RUC_CLIENTE}|CLIENTE EMPRESA S.A.C.|PEN|1000.00|0.00|0.00|0.00|0.00|180.00|0.00|1180.00||||||||`,
      `1|01|${fechaSunat}|03|0003|1||1|12345678|JUAN PÉREZ|PEN|296.61|0.00|0.00|0.00|0.00|53.39|0.00|350.00||||||||`,
    ]);
    expect(lineas[0]!.split('|')).toHaveLength(27); // 26 campos, cada uno cerrado con "|"
    expect((await dia()).informado).toBe(true);

    // Llega otra venta de ese día (otro celular sin señal): el día vuelve a estar pendiente
    // y el archivo nuevo (02) lleva las tres, porque reemplaza por completo al anterior.
    await registrar(venta({}, { fecha, serie: '0003', numero: 2 }));
    expect((await dia()).informado).toBe(false);
    const r2 = await generarInforme(db, almacen, { empresaId: f.empresaId, fecha });
    expect(r2).toMatchObject({ nombre: `${RUC_EMPRESA}-RF-${ddmmaaaa}-02.ZIP`, ventas: 3 });
  });

  // Pendiente que el dueño pidió cerrar: antes estas ventas no tocaban el stock, ni la Caja,
  // ni las Estadísticas (solo el Inicio y el Excel).
  it('descuenta stock, entra a la Caja por su medio y suma en las Estadísticas', async () => {
    const g = await crearEmpresa(db, `2060000017${digitoVerificadorRuc('2060000017')}`);
    await guardarProducto(db, g.empresaId, { sku: 'TAR-9', nombre: 'Tarima', precio: '350.00', controlaStock: true });
    await ajustarStock(db, g.empresaId, 'TAR-9', '5', 'conteo inicial');
    const cuerpo = venta({ items: [{ codigo: 'TAR-9', descripcion: 'Tarima', cantidad: 2, precio: '350.00' }] }, { serie: '0005', numero: 1 });
    await registrarContingencia(db, { empresaId: g.empresaId, cuerpo });
    await registrarContingencia(db, { empresaId: g.empresaId, cuerpo }); // repetido: no descuenta dos veces
    expect((await listarStock(db, g.empresaId)).find((x) => x.sku === 'TAR-9')?.stock).toBe('3');
    const c = await caja(db, g.empresaId, hoy, hoy);
    expect(c.cuentas).toEqual([expect.objectContaining({ medio: 'EFECTIVO', monto: '700.00', cobros: 1 })]);
    expect(c.vendido).toBe('700.00');
    const e = await estadisticas(db, g.empresaId, { hoy });
    expect(e.hoy).toMatchObject({ ventas: '700.00', comprobantes: 1 });
    expect(e.canales).toEqual([expect.objectContaining({ canal: 'Sin internet', ventas: '700.00' })]);
    expect(e.productos).toEqual([expect.objectContaining({ descripcion: 'Tarima', cantidad: '2', ventas: '700.00' })]);
  });

  it('el tablero avisa lo que falta informar', async () => {
    const t = await tablero(db, f.empresaId, { hoy });
    expect(t.contingencia).toMatchObject({ dias: 1, venceEn: 7 });
  });

  // ---------- Desde el panel ----------

  const entrar = (rol: Rol) => panel.entrar(f.empresaId, rol);
  const pedir: typeof panel.pedir = (ruta, o) => panel.pedir(ruta, o);

  it('el vendedor anota; el contador descarga el archivo; el Excel de ventas las incluye', async () => {
    const vendedor = await entrar('VENDEDOR');
    const contador = await entrar('CONTADOR');
    const r = await pedir('/panel/api/contingencia', { cookie: vendedor, cuerpo: { ...venta({}, { serie: '0009', numero: 99 }), canal: 'WhatsApp' } });
    expect(r.status).toBe(201);
    const mal = await pedir('/panel/api/contingencia', { cookie: vendedor, cuerpo: venta({ cliente: { tipoDocumento: 'DNI', numero: '123', nombre: 'X' } }) });
    expect(mal.status).toBe(422);
    expect((await mal.json()).error.detalles.join(' ')).toMatch(/DNI/);

    expect((await pedir('/panel/api/contingencia/informe', { cookie: vendedor, cuerpo: { fecha: hoy } })).status).toBe(403);
    expect((await pedir('/panel/api/contingencia', { cookie: vendedor })).status).toBe(403);
    expect((await (await pedir('/panel/api/contingencia', { cookie: contador })).json()).dias[0]).toMatchObject({ fecha: hoy, informado: false });
    const zip = await pedir('/panel/api/contingencia/informe', { cookie: contador, cuerpo: { fecha: hoy } });
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toMatch(new RegExp(`${RUC_EMPRESA}-RF-\\d{8}-01\\.ZIP`));

    const csv = await (await pedir(`/panel/api/exportar?que=ventas&mes=${hoy.slice(0, 7)}`, { cookie: contador })).text();
    expect(csv).toMatch(/Boleta impresa \(contingencia\);0009-99;12345678;JUAN PÉREZ;296\.61;53\.39;350\.00;IMPRESA: informar con archivo RF;PAGADO;WhatsApp/);
  });
});
