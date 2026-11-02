/**
 * Fase 8 — Inventario, compras, margen semanal e historial de clientes.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { procesarCola, type ServiciosEnvio } from '../../src/cola/procesar.js';
import { solicitarAnulacion } from '../../src/comprobantes/anular.js';
import { emitirComprobante } from '../../src/comprobantes/emitir.js';
import type { SolicitudComprobante } from '../../src/comprobantes/preparar.js';
import type { Db } from '../../src/db/conexion.js';
import { ahoraLima } from '../../src/fechas.js';
import { guardarCertificado } from '../../src/firma/repositorio-certificados.js';
import { registrarCompra, type DatosCompra } from '../../src/inventario/compras.js';
import { ajustarStock, guardarProducto, listarStock } from '../../src/inventario/productos.js';
import { historialCliente } from '../../src/reportes/cliente.js';
import { fijarMetaMargen, margenSemanal } from '../../src/reportes/margen.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { ClienteSunatSoap } from '../../src/sunat/cliente.js';
import { TipoComprobante } from '../../src/tipos.js';
import { digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { RUC_CLIENTE, item, solicitudBoleta } from '../ayudantes.js';
import { crearPfxPrueba } from '../certificado-prueba.js';
import { SunatSimulado } from '../sunat-simulado.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

describe.skipIf(!URL_PRUEBAS)('inventario', () => {
  let db: Db;
  let f: Fixture;
  let s: ServiciosEnvio;
  let reloj = new Date();
  const sunat = new SunatSimulado();
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const hoy = ahoraLima().fecha;

  beforeAll(async () => {
    db = await prepararBase();
    await sunat.iniciar();
    s = {
      almacen: new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-inventario-'))),
      llaveMaestra, algoritmo: 'SHA256', entorno: { SUNAT_URL_BETA: sunat.url },
      ahora: () => reloj,
      crearCliente: (url, credenciales) => new ClienteSunatSoap({ url, credenciales, tiempoMaximoMs: 400 }),
    };
  });
  afterAll(async () => {
    await sunat.detener();
    await db?.end();
  });
  beforeEach(async () => {
    sunat.reiniciar();
    reloj = new Date(Date.now() + 60_000);
    const base = `20${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
    await guardarCertificado(db, { empresaId: f.empresaId, pfx: crearPfxPrueba(), clave: 'clave-de-prueba', llaveMaestra });
    await guardarProducto(db, f.empresaId, { sku: 'tar-001', nombre: 'Tarima 2 plazas', precio: '354.00', stockMinimo: '2' });
  });

  async function emitir(solicitud: SolicitudComprobante = solicitudBoleta({ fechaEmision: hoy })): Promise<string> {
    const r = await emitirComprobante(db, { empresaId: f.empresaId, canalId: f.canalTienda, solicitud });
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join());
    return r.guardado.id;
  }

  const compra = (extra: Partial<DatosCompra> = {}): DatosCompra => ({
    proveedor: { ruc: RUC_CLIENTE, razonSocial: 'MADERAS DEL SUR S.A.C.' }, serie: 'F001', numero: 10, fecha: hoy,
    igv: '54.00', total: '354.00', items: [{ sku: 'TAR-001', descripcion: 'Tarima', cantidad: '2', costoUnitario: '150.00' }],
    ...extra,
  });

  async function stock(sku = 'TAR-001'): Promise<string> {
    return (await listarStock(db, f.empresaId)).find((x) => x.sku === sku)?.stock ?? 'no existe';
  }

  async function alertaStock(): Promise<{ severidad: string; mensaje: string } | undefined> {
    const r = await db.query(`SELECT severidad, mensaje FROM alertas WHERE empresa_id = $1 AND tipo = 'STOCK_BAJO' AND resuelta_en IS NULL`, [f.empresaId]);
    return r.rows[0];
  }

  it('la compra suma stock y fija el costo; la venta resta y guarda el costo del momento', async () => {
    await registrarCompra(db, f.empresaId, compra({ items: [{ sku: 'tar-001', descripcion: 'Tarima', cantidad: '5', costoUnitario: '60.00' }], igv: '54.00', total: '354.00' }));
    expect(await stock()).toBe('5');
    const id = await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '2', { codigo: 'tar-001' })] }));
    expect(await stock()).toBe('3');
    const it = await db.query(`SELECT producto_id IS NOT NULL AS enlazado, costo_unitario::text FROM comprobante_items WHERE comprobante_id = $1`, [id]);
    expect(it.rows[0]).toEqual({ enlazado: true, costo_unitario: '60.0000000000' });
  });

  it('costo promedio ponderado entre compras', async () => {
    await registrarCompra(db, f.empresaId, compra());                                    // 2 × 150
    await registrarCompra(db, f.empresaId, compra({ numero: 11, igv: '43.20', total: '283.20',
      items: [{ sku: 'TAR-001', descripcion: 'Tarima', cantidad: '1', costoUnitario: '240.00' }] })); // 1 × 240
    const c = await db.query(`SELECT costo_promedio::text FROM productos WHERE empresa_id = $1 AND sku = 'TAR-001'`, [f.empresaId]);
    expect(c.rows[0].costo_promedio).toBe('180.0000000000'); // (300 + 240) / 3
    expect(await stock()).toBe('3');
  });

  it('una compra que no cuadra o repetida se rechaza con un mensaje claro', async () => {
    await expect(registrarCompra(db, f.empresaId, compra({ total: '360.00' }))).rejects.toThrow(/no cuadran/);
    await registrarCompra(db, f.empresaId, compra());
    await expect(registrarCompra(db, f.empresaId, compra())).rejects.toThrow(/ya estaba registrada/);
    await expect(registrarCompra(db, f.empresaId, compra({ numero: 12, items: [{ sku: 'NO-EXISTE', descripcion: 'x', cantidad: '2', costoUnitario: '150.00' }] })))
      .rejects.toThrow(/No existe el producto NO-EXISTE/);
    expect(await stock()).toBe('2'); // lo fallido no dejó nada a medias
  });

  it('stock bajo el mínimo → alerta amarilla; negativo → roja; se cierra al reponer', async () => {
    await registrarCompra(db, f.empresaId, compra({ igv: '81.00', total: '531.00', items: [{ sku: 'TAR-001', descripcion: 'Tarima', cantidad: '3', costoUnitario: '150.00' }] }));
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '1')] }));
    expect((await alertaStock())?.severidad).toBe('AMARILLO');
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '3')] }));
    expect(await stock()).toBe('-1');
    expect(await alertaStock()).toMatchObject({ severidad: 'ROJO', mensaje: expect.stringMatching(/stock negativo/) });
    await ajustarStock(db, f.empresaId, 'TAR-001', '5', 'conteo físico');
    expect(await alertaStock()).toBeUndefined();
  });

  it('nota de crédito por devolución devuelve el stock; un descuento no', async () => {
    await registrarCompra(db, f.empresaId, compra());
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '2')] }));
    await procesarCola(db, s);
    const nc = (motivoCodigo: string, cantidad: string) => solicitudBoleta({
      fechaEmision: hoy, tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01', items: [item('354.00', cantidad)],
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo, motivoDescripcion: 'NC' },
    });
    await emitir(nc('07', '1'));
    expect(await stock()).toBe('1');
    await emitir(nc('05', '1')); // descuento por ítem: el producto no vuelve
    expect(await stock()).toBe('1');
  });

  it('anulación aceptada por SUNAT revierte el stock sin borrar movimientos', async () => {
    await registrarCompra(db, f.empresaId, compra());
    const id = await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '2')] }));
    await procesarCola(db, s);
    expect(await stock()).toBe('0');
    await solicitarAnulacion(db, { empresaId: f.empresaId, comprobanteId: id, motivo: 'Venta cancelada', hoy });
    await procesarCola(db, s); // envía el resumen
    reloj = new Date(reloj.getTime() + 60_000);
    await procesarCola(db, s); // ticket aceptado
    expect(await stock()).toBe('2');
    const m = await db.query(`SELECT tipo::text FROM movimientos_stock WHERE comprobante_id = $1 ORDER BY id`, [id]);
    expect(m.rows.map((x) => x.tipo)).toEqual(['VENTA', 'ANULACION']);
    await expect(db.query(`DELETE FROM movimientos_stock WHERE comprobante_id = $1`, [id])).rejects.toThrow();
  });

  it('ajuste manual exige motivo y no acepta cero', async () => {
    await expect(ajustarStock(db, f.empresaId, 'TAR-001', '1', '  ')).rejects.toThrow(/motivo/);
    await expect(ajustarStock(db, f.empresaId, 'TAR-001', '0', 'x')).rejects.toThrow(/cero/);
    expect(await ajustarStock(db, f.empresaId, 'TAR-001', '4', 'inventario inicial')).toBe('4');
  });

  it('producto sin control de stock: no mueve stock pero aporta costo al margen', async () => {
    await guardarProducto(db, f.empresaId, { sku: 'ROP-01', nombre: 'Ropero a medida', precio: '1180.00', controlaStock: false });
    await registrarCompra(db, f.empresaId, compra({ igv: '90.00', total: '590.00', items: [{ sku: 'ROP-01', descripcion: 'Material', cantidad: '1', costoUnitario: '500.00' }] }));
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('1180.00', '1', { codigo: 'ROP-01', descripcion: 'Ropero' })] }));
    expect((await listarStock(db, f.empresaId)).map((x) => x.sku)).toEqual(['TAR-001']);
    const m = await margenSemanal(db, f.empresaId, hoy);
    expect(m).toMatchObject({ ventas: '1000.00', costo: '500.00', margen: '500.00', porcentaje: '50.0' });
  });

  it('margen semanal: ventas − costo, NC por devolución, ítems sin costo aparte y meta', async () => {
    await registrarCompra(db, f.empresaId, compra()); // costo 150
    await fijarMetaMargen(db, f.empresaId, '3000', hoy);
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '2'), item('59.00', '1', { codigo: 'SIN-SKU', descripcion: 'Almohada' })] }));
    await procesarCola(db, s);
    await emitir(solicitudBoleta({
      fechaEmision: hoy, tipo: TipoComprobante.NOTA_CREDITO, serie: 'BC01', items: [item('354.00', '1')],
      notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 1 }, motivoCodigo: '07', motivoDescripcion: 'Devolución' },
    }));
    const m = await margenSemanal(db, f.empresaId, hoy);
    // Ventas: 600 + 50 − 300 = 350; costo: 300 − 150 = 150; margen sobre lo con costo: 300 − 150 = 150.
    expect(m).toMatchObject({ ventas: '350.00', costo: '150.00', margen: '150.00', porcentaje: '50.0', sinCosto: { items: 1, ventas: '50.00' } });
    expect(m.meta).toEqual({ monto: '3000.00', cumplimiento: '5.0' });
    // Un descuento global (cupón) baja la venta y el margen.
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00', '1')], descuentoGlobal: '59.00' })); // −50.00 sin IGV
    expect(await margenSemanal(db, f.empresaId, hoy)).toMatchObject({ ventas: '600.00', costo: '300.00', margen: '250.00' });
    expect(new Date(`${m.desde}T00:00:00Z`).getUTCDay()).toBe(1); // lunes
  });

  it('historial del cliente: comprobantes, total comprado y saldo', async () => {
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('354.00')] }));
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('100.00')], cliente: { tipoDoc: '1', numeroDoc: '12345678', nombre: 'JUAN PÉREZ R.' } }));
    await emitir(solicitudBoleta({ fechaEmision: hoy, items: [item('50.00')], cliente: { tipoDoc: '1', numeroDoc: '87654321', nombre: 'OTRA PERSONA' } }));
    const h = await historialCliente(db, f.empresaId, '12345678');
    expect(h?.cliente.nombre).toBe('JUAN PÉREZ R.'); // se actualiza con el último dato
    expect(h?.comprobantes.map((c) => c.numero)).toEqual(['B001-00000001', 'B001-00000002']);
    expect(h).toMatchObject({ totalComprado: '454.00', saldoPendiente: '454.00' });
    expect(await historialCliente(db, f.empresaId, '00000000')).toBeUndefined();
  });
});
