/**
 * Alta o actualización de una empresa con lo necesario para emitir:
 * régimen, series (F001, B001, FC01, BC01, FD01, BD01), marca y canales por defecto.
 * Se puede ejecutar varias veces: solo crea lo que falta.
 */
import { enTransaccion, type Db } from '../db/conexion.js';
import type { FormatoPdf } from '../pdf/representacion.js';
import type { Regimen } from '../tipos.js';
import { esRucValido } from '../validaciones/documentos.js';

export interface DatosEmpresa {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string;
  ubigeo: string;
  departamento: string;
  provincia: string;
  distrito: string;
  direccion: string;
  regimen: Regimen;
  /** Fecha desde la que rige el régimen (AAAA-MM-DD). */
  regimenDesde: string;
  marca?: string;
}

const SERIES: [string, string][] = [['01', 'F001'], ['03', 'B001'], ['07', 'FC01'], ['07', 'BC01'], ['08', 'FD01'], ['08', 'BD01']];
const CANALES: [string, 'API' | 'MANUAL', FormatoPdf][] = [
  ['Tienda web', 'API', 'A4'],
  ['WhatsApp', 'MANUAL', 'A4'],
  ['Instagram', 'MANUAL', 'A4'],
  ['Presencial', 'MANUAL', 'TICKET_80'],
];

export class ErrorEmpresa extends Error {}

export async function configurarEmpresa(db: Db, d: DatosEmpresa): Promise<{ empresaId: string; creada: boolean }> {
  if (!esRucValido(d.ruc)) throw new ErrorEmpresa(`RUC inválido: ${d.ruc}`);
  if (!/^\d{6}$/.test(d.ubigeo)) throw new ErrorEmpresa('El ubigeo debe tener 6 dígitos (catálogo de SUNAT/INEI).');
  return enTransaccion(db, async (tx) => {
    const r = await tx.query(
      `INSERT INTO empresas (ruc, razon_social, nombre_comercial, ubigeo, departamento, provincia, distrito, direccion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (ruc) DO UPDATE SET razon_social = EXCLUDED.razon_social, nombre_comercial = EXCLUDED.nombre_comercial,
         ubigeo = EXCLUDED.ubigeo, departamento = EXCLUDED.departamento, provincia = EXCLUDED.provincia,
         distrito = EXCLUDED.distrito, direccion = EXCLUDED.direccion
       RETURNING id, (xmax = 0) AS creada`,
      [d.ruc, d.razonSocial, d.nombreComercial ?? null, d.ubigeo, d.departamento, d.provincia, d.distrito, d.direccion],
    );
    const empresaId = r.rows[0].id as string;
    await tx.query(
      `INSERT INTO empresa_regimen (empresa_id, regimen, vigente_desde) VALUES ($1, $2, $3) ON CONFLICT (empresa_id, vigente_desde) DO NOTHING`,
      [empresaId, d.regimen, d.regimenDesde],
    );
    for (const [tipo, serie] of SERIES) {
      await tx.query(
        `INSERT INTO series (empresa_id, tipo_comprobante, serie) VALUES ($1, $2, $3) ON CONFLICT (empresa_id, tipo_comprobante, serie) DO NOTHING`,
        [empresaId, tipo, serie],
      );
    }
    let marcaId: string | null = null;
    if (d.marca) {
      const m = await tx.query(
        `INSERT INTO marcas (empresa_id, nombre) VALUES ($1, $2) ON CONFLICT (empresa_id, nombre) DO UPDATE SET activa = true RETURNING id`,
        [empresaId, d.marca],
      );
      marcaId = m.rows[0].id as string;
    }
    for (const [nombre, tipo, formato] of CANALES) {
      await tx.query(
        `INSERT INTO canales (empresa_id, nombre, tipo, formato_pdf, marca_id_por_defecto) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (empresa_id, nombre) DO NOTHING`,
        [empresaId, nombre, tipo, formato, marcaId],
      );
    }
    await tx.query(
      `INSERT INTO auditoria (empresa_id, accion, entidad, entidad_id, despues) VALUES ($1, 'CONFIGURAR_EMPRESA', 'empresas', $1, $2)`,
      [empresaId, JSON.stringify({ ruc: d.ruc, regimen: d.regimen, marca: d.marca ?? null })],
    );
    return { empresaId, creada: Boolean(r.rows[0].creada) };
  });
}
