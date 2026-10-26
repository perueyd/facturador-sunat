/**
 * Pruebas con PostgreSQL real: correlativos, duplicados, transacciones y protecciones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emitirComprobante, type PedidoEmision, type ResultadoEmision } from '../../src/comprobantes/emitir.js';
import { cargarComprobante } from '../../src/comprobantes/repositorio.js';
import type { Db } from '../../src/db/conexion.js';
import { Afectacion, TipoComprobante } from '../../src/tipos.js';
import { TipoDocIdentidad, digitoVerificadorRuc } from '../../src/validaciones/documentos.js';
import { generarXmlComprobante } from '../../src/xml/comprobante.js';
import { RUC_PERSONA, item, solicitudBoleta, solicitudFactura, validarContraXsd } from '../ayudantes.js';
import { URL_PRUEBAS, crearEmpresa, prepararBase, type Fixture } from './base-prueba.js';

if (!URL_PRUEBAS && process.env.PERMITIR_SIN_BD !== '1') {
  it('las pruebas de base de datos son obligatorias', () => {
    throw new Error(
      'Falta DATABASE_URL_PRUEBAS. Ejecuta `npm run db:prueba` y exporta la URL que muestra. ' +
        '(Solo para trabajar sin base: PERMITIR_SIN_BD=1)',
    );
  });
}

describe.skipIf(!URL_PRUEBAS)('emisión con base de datos', () => {
  let db: Db;
  let f: Fixture;

  beforeAll(async () => {
    db = await prepararBase();
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    // Cada prueba usa una empresa nueva (RUC distinto) para empezar las series en cero.
    const n = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const base = `20${n}`;
    f = await crearEmpresa(db, base + digitoVerificadorRuc(base));
  });

  const pedido = (extra: Partial<PedidoEmision> = {}): PedidoEmision => ({
    empresaId: f.empresaId,
    canalId: f.canalTienda,
    marcaId: f.marcaId,
    solicitud: solicitudBoleta(),
    ...extra,
  });

  function emitido(r: ResultadoEmision) {
    if (r.resultado === 'ERROR_VALIDACION') throw new Error(r.errores.join('\n'));
    return r.guardado;
  }

  async function ultimoNumero(serie: string): Promise<number> {
    const r = await db.query(`SELECT ultimo_numero FROM series WHERE empresa_id = $1 AND serie = $2`, [f.empresaId, serie]);
    return Number(r.rows[0].ultimo_numero);
  }

  it('emite y guarda una boleta con su número, ítems, historial, cola y auditoría', async () => {
    const r = await emitirComprobante(db, pedido());
    expect(r.resultado).toBe('EMITIDO');
    const g = emitido(r);
    expect(g.comprobante.serie).toBe('B001');
    expect(g.comprobante.numero).toBe(1);
    expect(g.estado).toBe('EMITIDO_LOCAL');
    expect(g.comprobante.totales.importeTotal.toFixed(2)).toBe('350.00');

    const ev = await db.query(`SELECT estado_nuevo FROM comprobante_eventos WHERE comprobante_id = $1`, [g.id]);
    expect(ev.rows.map((x) => x.estado_nuevo)).toEqual(['EMITIDO_LOCAL']);
    const cola = await db.query(`SELECT estado FROM cola_envios WHERE referencia_id = $1`, [g.id]);
    expect(cola.rows[0]?.estado).toBe('PENDIENTE');
    const aud = await db.query(`SELECT accion FROM auditoria WHERE entidad_id = $1`, [g.id]);
    expect(aud.rows[0]?.accion).toBe('EMITIR');
  });

  it('el XML del comprobante guardado es idéntico al calculado y cumple UBL 2.1', async () => {
    const g = emitido(await emitirComprobante(db, pedido({ solicitud: solicitudFactura() })));
    const recargado = await cargarComprobante(db, g.id);
    const xml = generarXmlComprobante(recargado.comprobante);
    expect(() => validarContraXsd(xml, 'UBL-Invoice-2.1.xsd')).not.toThrow();
    expect(xml).toContain('<cbc:PayableAmount currencyID="PEN">1299.80</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="PEN">50.7627118644</cbc:PriceAmount>');
  });

  it('correlativos consecutivos por serie, compartidos entre canales', async () => {
    const a = emitido(await emitirComprobante(db, pedido({ canalId: f.canalTienda })));
    const b = emitido(await emitirComprobante(db, pedido({ canalId: f.canalManual })));
    const c = emitido(await emitirComprobante(db, pedido({ solicitud: solicitudFactura() })));
    expect([a.comprobante.numero, b.comprobante.numero]).toEqual([1, 2]);
    expect(c.comprobante.serie).toBe('F001');
    expect(c.comprobante.numero).toBe(1);
  });

  it('40 emisiones simultáneas: números 1 a 40, sin saltos ni duplicados', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 40 }, (_, i) => emitirComprobante(db, pedido({ pedidoExternoId: `P-${i}` }))),
    );
    const numeros = resultados.map((r) => emitido(r).comprobante.numero).sort((x, y) => x - y);
    expect(numeros).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(await ultimoNumero('B001')).toBe(40);
  });

  it('un error de validación NO consume número', async () => {
    emitido(await emitirComprobante(db, pedido()));
    const mala = await emitirComprobante(db, pedido({ solicitud: solicitudBoleta({ cliente: { tipoDoc: TipoDocIdentidad.DNI, numeroDoc: '123', nombre: 'X' } }) }));
    expect(mala.resultado).toBe('ERROR_VALIDACION');
    const siguiente = emitido(await emitirComprobante(db, pedido()));
    expect(siguiente.comprobante.numero).toBe(2);
  });

  it('un fallo de base de datos a mitad de la emisión deshace todo y NO consume número', async () => {
    emitido(await emitirComprobante(db, pedido()));
    // Un total de S/ 1 billón no cabe en la columna NUMERIC(14,2): el INSERT falla
    // DESPUÉS de haber tomado el número de la serie.
    await expect(
      emitirComprobante(db, pedido({ solicitud: solicitudBoleta({ items: [item('1.00', '1000000000000')] }) })),
    ).rejects.toThrow(/numeric field overflow/);
    expect(await ultimoNumero('B001')).toBe(1);
    const n = await db.query(`SELECT count(*)::int AS n FROM comprobantes WHERE empresa_id = $1`, [f.empresaId]);
    expect(n.rows[0].n).toBe(1);
    expect(emitido(await emitirComprobante(db, pedido())).comprobante.numero).toBe(2);
  });

  it('pedido repetido: devuelve el mismo comprobante sin emitir otro', async () => {
    const primero = emitido(await emitirComprobante(db, pedido({ pedidoExternoId: 'ED-1001' })));
    const repetido = await emitirComprobante(db, pedido({ pedidoExternoId: 'ED-1001' }));
    expect(repetido.resultado).toBe('REPETIDO');
    expect(emitido(repetido).id).toBe(primero.id);
    expect(await ultimoNumero('B001')).toBe(1);
  });

  it('pedido cuyo comprobante SUNAT rechazó: emite uno nuevo con el siguiente número; el rechazado se conserva', async () => {
    const rechazado = emitido(await emitirComprobante(db, pedido({ pedidoExternoId: 'ED-3003' })));
    await db.query(`UPDATE comprobantes SET estado = 'RECHAZADO' WHERE id = $1`, [rechazado.id]);
    const nuevo = await emitirComprobante(db, pedido({ pedidoExternoId: 'ED-3003' }));
    expect(nuevo.resultado).toBe('EMITIDO');
    expect(emitido(nuevo).comprobante.numero).toBe(2);
    const otraVez = await emitirComprobante(db, pedido({ pedidoExternoId: 'ED-3003' }));
    expect(otraVez.resultado).toBe('REPETIDO');
    expect(emitido(otraVez).id).toBe(emitido(nuevo).id);
    const n = await db.query(`SELECT count(*)::int AS n FROM comprobantes WHERE pedido_externo_id = 'ED-3003' AND empresa_id = $1`, [f.empresaId]);
    expect(n.rows[0].n).toBe(2);
  });

  it('pedido repetido llegando 10 veces al mismo tiempo: un solo comprobante', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => emitirComprobante(db, pedido({ pedidoExternoId: 'ED-2002' }))));
    const ids = new Set(rs.map((r) => emitido(r).id));
    expect(ids.size).toBe(1);
    expect(rs.filter((r) => r.resultado === 'EMITIDO')).toHaveLength(1);
    expect(await ultimoNumero('B001')).toBe(1);
  });

  it('el mismo número de pedido en otro canal es otro pedido', async () => {
    const a = emitido(await emitirComprobante(db, pedido({ pedidoExternoId: 'X-1', canalId: f.canalTienda })));
    const b = emitido(await emitirComprobante(db, pedido({ pedidoExternoId: 'X-1', canalId: f.canalManual })));
    expect(a.id).not.toBe(b.id);
  });

  it('nota de crédito: total o parcial, nunca más que el saldo del original', async () => {
    const boleta = emitido(await emitirComprobante(db, pedido({ solicitud: solicitudBoleta({ items: [item('100.00', '3')] }) })));
    const nc = (monto: string) =>
      emitirComprobante(db, pedido({
        solicitud: {
          ...solicitudBoleta({ items: [item(monto)] }),
          tipo: TipoComprobante.NOTA_CREDITO,
          serie: 'BC01',
          notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: boleta.comprobante.numero }, motivoCodigo: '07', motivoDescripcion: 'Devolución' },
        },
      }));
    const primera = emitido(await nc('200.00'));
    expect(primera.comprobante.notaCredito?.referencia.numero).toBe(1);
    expect(primera.comprobante.cliente.numeroDoc).toBe('12345678'); // copia el cliente del original
    const excede = await nc('100.01');
    expect(excede.resultado).toBe('ERROR_VALIDACION');
    if (excede.resultado === 'ERROR_VALIDACION') expect(excede.errores[0]).toMatch(/supera el saldo.*S\/ 100.00/);
    emitido(await nc('100.00'));
    expect(await ultimoNumero('BC01')).toBe(2);
  });

  it('nota de crédito de un comprobante que no existe', async () => {
    const r = await emitirComprobante(db, pedido({
      solicitud: {
        ...solicitudBoleta(),
        tipo: TipoComprobante.NOTA_CREDITO,
        serie: 'BC01',
        notaCredito: { referencia: { tipo: TipoComprobante.BOLETA, serie: 'B001', numero: 999 }, motivoCodigo: '01', motivoDescripcion: 'Anulación' },
      },
    }));
    expect(r.resultado).toBe('ERROR_VALIDACION');
    if (r.resultado === 'ERROR_VALIDACION') expect(r.errores[0]).toMatch(/No existe el comprobante B001-00000999/);
  });

  it('Nuevo RUS: bloquea facturas según la tabla de regímenes', async () => {
    const rus = await crearEmpresa(db, RUC_PERSONA, 'NUEVO_RUS');
    const r = await emitirComprobante(db, { empresaId: rus.empresaId, canalId: rus.canalManual, solicitud: solicitudFactura() });
    expect(r.resultado).toBe('ERROR_VALIDACION');
    if (r.resultado === 'ERROR_VALIDACION') expect(r.errores.join(' ')).toMatch(/Nuevo RUS/);
  });

  it('exoneración (taxi) solo para empresas que la tienen configurada', async () => {
    const taxi = solicitudBoleta({ items: [item('20.00', '1', { descripcion: 'Carrera', unidad: 'ZZ', afectacion: Afectacion.EXONERADO })] });
    expect((await emitirComprobante(db, pedido({ solicitud: taxi }))).resultado).toBe('ERROR_VALIDACION');
    await db.query(`INSERT INTO empresa_exoneraciones (empresa_id, exoneracion_codigo) VALUES ($1, 'TRANSPORTE_PASAJEROS')`, [f.empresaId]);
    const g = emitido(await emitirComprobante(db, pedido({ solicitud: taxi })));
    expect(g.comprobante.totales.exonerado.toFixed(2)).toBe('20.00');
    expect(g.comprobante.totales.igv.toFixed(2)).toBe('0.00');
  });

  it('serie inexistente o desactivada', async () => {
    const r = await emitirComprobante(db, pedido({ solicitud: solicitudBoleta({ serie: 'B999' }) }));
    expect(r.resultado).toBe('ERROR_VALIDACION');
    await db.query(`UPDATE series SET activa = false WHERE empresa_id = $1 AND serie = 'B001'`, [f.empresaId]);
    expect((await emitirComprobante(db, pedido())).resultado).toBe('ERROR_VALIDACION');
  });

  it('canal desactivado (llave filtrada) no puede emitir', async () => {
    await db.query(`UPDATE canales SET activo = false WHERE id = $1`, [f.canalTienda]);
    const r = await emitirComprobante(db, pedido());
    expect(r.resultado).toBe('ERROR_VALIDACION');
  });

  it('fecha futura no se acepta', async () => {
    const r = await emitirComprobante(db, pedido({ solicitud: solicitudBoleta({ fechaEmision: '2099-01-01' }) }));
    expect(r.resultado).toBe('ERROR_VALIDACION');
  });

  describe('protecciones de la base de datos', () => {
    it('no se puede borrar un comprobante', async () => {
      const g = emitido(await emitirComprobante(db, pedido()));
      await expect(db.query(`DELETE FROM comprobantes WHERE id = $1`, [g.id])).rejects.toThrow(/No se permite borrar/);
    });

    it('no se puede cambiar el monto ni el número de un comprobante emitido', async () => {
      const g = emitido(await emitirComprobante(db, pedido()));
      await expect(db.query(`UPDATE comprobantes SET importe_total = 1 WHERE id = $1`, [g.id])).rejects.toThrow(/no se puede modificar/);
      await expect(db.query(`UPDATE comprobantes SET numero = 99 WHERE id = $1`, [g.id])).rejects.toThrow(/no se puede modificar/);
      await expect(db.query(`UPDATE comprobante_items SET total = 1 WHERE comprobante_id = $1`, [g.id])).rejects.toThrow(/solo inserción/);
    });

    it('sí se puede actualizar el estado (para la respuesta de SUNAT)', async () => {
      const g = emitido(await emitirComprobante(db, pedido()));
      await db.query(`UPDATE comprobantes SET estado = 'ACEPTADO', sunat_codigo_respuesta = '0' WHERE id = $1`, [g.id]);
      expect((await cargarComprobante(db, g.id)).estado).toBe('ACEPTADO');
    });

    it('el correlativo de una serie no puede retroceder', async () => {
      emitido(await emitirComprobante(db, pedido()));
      await expect(db.query(`UPDATE series SET ultimo_numero = 0 WHERE empresa_id = $1 AND serie = 'B001'`, [f.empresaId])).rejects.toThrow(/no puede retroceder/);
    });

    it('historial y auditoría son de solo inserción', async () => {
      const g = emitido(await emitirComprobante(db, pedido()));
      await expect(db.query(`DELETE FROM comprobante_eventos WHERE comprobante_id = $1`, [g.id])).rejects.toThrow(/solo inserción/);
      await expect(db.query(`UPDATE auditoria SET accion = 'X' WHERE entidad_id = $1`, [g.id])).rejects.toThrow(/solo inserción/);
    });

    it('no se puede pasar a producción sin registrar quién lo autorizó', async () => {
      await expect(db.query(`UPDATE empresas SET ambiente_sunat = 'PRODUCCION' WHERE id = $1`, [f.empresaId])).rejects.toThrow();
    });

    it('una empresa no puede usar la serie ni el canal de otra', async () => {
      const otra = await crearEmpresa(db, '20100170338');
      const r = await emitirComprobante(db, { empresaId: otra.empresaId, canalId: f.canalTienda, solicitud: solicitudBoleta() });
      expect(r.resultado).toBe('ERROR_VALIDACION');
      if (r.resultado === 'ERROR_VALIDACION') expect(r.errores[0]).toMatch(/no pertenece a esta empresa/);
    });
  });
});
