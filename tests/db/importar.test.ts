/**
 * Productos sin escribirlos uno por uno: importados del catálogo de la tienda web o de un
 * Excel (CSV), y sugeridos en Vender a partir de lo que ya se vendió.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlmacenLocal } from '../../src/almacen/almacen.js';
import { crearApp } from '../../src/api/app.js';
import type { Db } from '../../src/db/conexion.js';
import { descargarCatalogo, importarProductos, leerCatalogo } from '../../src/inventario/importar.js';
import { ajustarStock, guardarProducto } from '../../src/inventario/productos.js';
import type { Rol } from '../../src/panel/usuarios.js';
import { generarLlaveMaestra } from '../../src/seguridad/cifrado.js';
import { URL_PRUEBAS, crearEmpresa, panelDePrueba, prepararBase, type Fixture } from './base-prueba.js';

// Como lo publica la tienda en /api/feed?formato=csv (columnas de Meta).
const CSV_TIENDA = [
  'id,title,description,availability,condition,price,link,image_link,brand,product_type',
  '"tarima-milan-2p","Tarima Milán — 2 plazas","Tarima de melamina, color nogal",in stock,new,"350.00 PEN","https://x/p",,"E|D","Tarimas"',
  '"cabecera-roma-queen","Cabecera Roma — Queen","Tapizada,\nen lino","in stock","new","599.90 PEN",,,,',
  '"sin-precio","Algo raro","",in stock,new,"",,,,',
].join('\n');

describe('leer el catálogo', () => {
  it('el de la tienda web: código, nombre y precio; comas y saltos de línea dentro de comillas', () => {
    const r = leerCatalogo(CSV_TIENDA);
    expect(r.productos).toEqual([
      { sku: 'TARIMA-MILAN-2P', nombre: 'Tarima Milán — 2 plazas', precio: '350.00' },
      { sku: 'CABECERA-ROMA-QUEEN', nombre: 'Cabecera Roma — Queen', precio: '599.90' },
    ]);
    expect(r.errores).toEqual(['Fila 4: falta el código, el nombre o un precio válido.']);
  });

  it('un Excel en español guardado como CSV (punto y coma, coma decimal, títulos con tilde)', () => {
    const r = leerCatalogo('﻿Código;Nombre;Precio\nALM-01;Almohada viscoelástica;59,90\nCOL 02;Colchón 2 plazas;S/ 899\n');
    expect(r.productos).toEqual([
      { sku: 'ALM-01', nombre: 'Almohada viscoelástica', precio: '59.90' },
      { sku: 'COL-02', nombre: 'Colchón 2 plazas', precio: '899' },
    ]);
  });

  it('sin las columnas necesarias, lo explica', () => {
    expect(() => leerCatalogo('a;b\n1;2')).toThrow(/código \(o id\), nombre \(o title\) y precio/);
  });
});

describe('descargar el catálogo de la tienda', () => {
  const respuesta = (texto: string) => (async () => new Response(texto)) as unknown as typeof fetch;
  it('solo direcciones públicas https: nunca la red interna del servidor', async () => {
    for (const mala of ['http://eydperu.vercel.app/api/feed', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://servidor.internal/x', 'https://a.com:8443/x', 'no es url']) {
      await expect(descargarCatalogo(mala, respuesta('x'))).rejects.toThrow();
    }
    expect(await descargarCatalogo('https://eydperu.vercel.app/api/feed?formato=csv', respuesta(CSV_TIENDA))).toBe(CSV_TIENDA);
  });
  it('no sigue redirecciones (podrían llevar a una dirección interna)', async () => {
    let opciones: RequestInit | undefined;
    const espia = (async (_u: unknown, o: RequestInit) => { opciones = o; return new Response('id,title,price'); }) as unknown as typeof fetch;
    await descargarCatalogo('https://eydperu.vercel.app/api/feed?formato=csv', espia);
    expect(opciones?.redirect).toBe('error');
  });
});

describe.skipIf(!URL_PRUEBAS)('importar y sugerir productos', () => {
  let db: Db;
  let f: Fixture;
  let panel: ReturnType<typeof panelDePrueba>;
  const llaveMaestra = Buffer.from(generarLlaveMaestra(), 'base64');
  const entrar = (rol: Rol) => panel.entrar(f.empresaId, rol);

  beforeAll(async () => {
    db = await prepararBase();
    f = await crearEmpresa(db);
    const almacen = new AlmacenLocal(await mkdtemp(join(tmpdir(), 'almacen-importar-')));
    const app = crearApp({ db, fallosPorMinuto: 1000, servicios: { almacen, llaveMaestra, algoritmo: 'SHA256', crearCliente: () => { throw new Error('sin SUNAT'); } } });
    panel = panelDePrueba(app, db, llaveMaestra);
  });
  afterAll(async () => {
    await db?.end();
  });

  it('crea los nuevos (sin controlar stock) y al repetir solo actualiza nombre y precio', async () => {
    await guardarProducto(db, f.empresaId, { sku: 'TARIMA-MILAN-2P', nombre: 'Tarima vieja', precio: '300.00', controlaStock: true, codigoBarras: '7750000000011' });
    await ajustarStock(db, f.empresaId, 'TARIMA-MILAN-2P', '5', 'conteo inicial');
    const { productos } = leerCatalogo(CSV_TIENDA);
    expect(await importarProductos(db, f.empresaId, productos)).toEqual({ nuevos: 1, actualizados: 1 });
    const filas = (await db.query(
      `SELECT sku, nombre, precio_con_igv::numeric(14,2)::text AS precio, controla_stock, codigo_barras FROM productos WHERE empresa_id = $1 ORDER BY sku`,
      [f.empresaId],
    )).rows;
    expect(filas).toEqual([
      { sku: 'CABECERA-ROMA-QUEEN', nombre: 'Cabecera Roma — Queen', precio: '599.90', controla_stock: false, codigo_barras: null },
      // El que ya existía conserva su control de stock y su código de barras.
      { sku: 'TARIMA-MILAN-2P', nombre: 'Tarima Milán — 2 plazas', precio: '350.00', controla_stock: true, codigo_barras: '7750000000011' },
    ]);
    expect(await importarProductos(db, f.empresaId, productos)).toEqual({ nuevos: 0, actualizados: 2 });
  });

  it('desde el panel: el dueño importa; el vendedor no; Vender sugiere lo vendido antes con su último precio', async () => {
    const dueno = await entrar('DUENO');
    const vendedor = await entrar('VENDEDOR');
    const csv = 'codigo;nombre;precio\nALM-01;Almohada;59,90';
    expect((await panel.pedir('/panel/api/productos/importar', { cookie: vendedor, cuerpo: { csv } })).status).toBe(403);
    expect(await (await panel.pedir('/panel/api/productos/importar', { cookie: dueno, cuerpo: { csv } })).json()).toEqual({ nuevos: 1, actualizados: 0, errores: [] });
    const mala = await panel.pedir('/panel/api/productos/importar', { cookie: dueno, cuerpo: { direccion: 'http://10.0.0.1/catalogo' } });
    expect(mala.status).toBe(422);

    const vender = (descripcion: string, precio: string) => panel.pedir('/panel/api/comprobantes', {
      cookie: vendedor,
      cuerpo: { pedido: `PANEL-${crypto.randomUUID()}`, canal: 'WhatsApp', tipo: 'BOLETA', items: [{ descripcion, cantidad: 1, precio }] },
    });
    expect((await vender('Armado e instalación', '50.00')).status).toBe(201);
    expect((await vender('Armado e instalación', '60.00')).status).toBe(201);
    expect((await vender('Almohada', '59.90')).status).toBe(201);
    const { vendidos } = await (await panel.pedir('/panel/api/vendidos', { cookie: vendedor })).json();
    // El último precio, y no se repite lo que ya es un producto guardado (Almohada).
    expect(vendidos).toEqual([{ codigo: null, descripcion: 'Armado e instalación', precio: '60.00' }]);
  });
});
