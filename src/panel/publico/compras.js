// Panel del facturador · Compras, cuentas por pagar y stock.
// Secciones: Compras; Cuentas por pagar; Stock.
// Los archivos del panel se cargan en orden (ver index.html) y comparten sus funciones:
// lo de un archivo anterior se puede usar aquí directamente.
'use strict';

// ---------- Compras ----------
function agregarLineaCompra() {
  const nodo = $('#plantilla-compra').content.cloneNode(true);
  nodo.querySelector('.quitar').addEventListener('click', (e) => {
    if (document.querySelectorAll('#items-compra .item').length > 1) e.target.closest('.item').remove();
    sugerirMontosCompra();
  });
  for (const i of nodo.querySelectorAll('input')) i.addEventListener('input', sugerirMontosCompra);
  $('#items-compra').appendChild(nodo);
}

// Sugiere IGV y total a partir del detalle, con la tasa vigente que manda el facturador;
// el usuario los corrige si la factura dice otra cosa.
function sugerirMontosCompra() {
  const tasa = /^0\.\d{1,6}$/.test(yo?.igvTasa ?? '') ? BigInt((yo.igvTasa.slice(2) + '0000').slice(0, 4)) : null; // en diezmilésimos
  if (tasa === null) return;
  let base = 0n;
  for (const fila of document.querySelectorAll('#items-compra .item')) {
    const costo = aCentimos(fila.querySelector('[name=costoUnitario]').value || '0');
    const cantidad = fila.querySelector('[name=cantidad]').value.trim();
    if (costo === null || !/^\d+$/.test(cantidad)) return;
    base += costo * BigInt(cantidad);
  }
  const igv = (base * tasa + 5000n) / 10000n;
  const f = $('#form-compra');
  f.igv.value = textoSoles(igv).slice(3);
  f.total.value = textoSoles(base + igv).slice(3);
}

async function cargarCompras() {
  const { compras } = await api('/compras');
  $('#lista-compras').replaceChildren(...compras.map((x) => linea(`${x.fecha} · ${x.numero} · ${x.proveedor}${x.vence ? ` · crédito hasta ${fechaPeru(x.vence)}` : ''}`, `S/ ${x.total} (IGV ${x.igv})`)));
  await cargarPorPagar();
  if (!$('#items-compra').children.length) agregarLineaCompra();
  if (!$('#form-compra').fecha.value) $('#form-compra').fecha.value = new Date().toISOString().slice(0, 10);
  if (tiene('productos')) {
    const { stock } = await api('/stock');
    $('#lista-skus').replaceChildren(...stock.map((p) => new Option(p.nombre, p.sku)));
  }
}

// ---------- Cuentas por pagar ----------
const ESTADO_DEUDA = { VENCIDA: '⚠️ vencida', VENCE_PRONTO: 'vence pronto', AL_DIA: 'al día' };

async function cargarPorPagar() {
  const { deudas, resumen } = await api('/por-pagar');
  $('#kpis-por-pagar').replaceChildren(
    kpi(resumen.total === '0.00' ? 'gris' : 'azul', 'Debes', soles(resumen.total), `${resumen.proveedores} proveedor(es)`),
    kpi(resumen.vencido === '0.00' ? 'gris' : 'rosa', 'Vencido', soles(resumen.vencido), 'pagar cuanto antes'),
    kpi(resumen.vencePronto === '0.00' ? 'gris' : 'ambar', 'Vence en 7 días', soles(resumen.vencePronto), 'prepara el pago'),
  );
  $('#lista-por-pagar').replaceChildren(...(deudas.length ? deudas.map((x) => {
    const cuando = x.diasParaVencer < 0 ? `venció hace ${-x.diasParaVencer} día(s)` : x.diasParaVencer === 0 ? 'vence hoy' : `vence en ${x.diasParaVencer} día(s)`;
    const li = linea(`${x.proveedor} · ${x.documento} · ${cuando} (${ESTADO_DEUDA[x.estado]})`, `debes ${soles(x.saldo)}`, x.estado === 'VENCIDA' ? 'bajo' : '');
    li.addEventListener('click', (e) => {
      if (e.target.closest('.pago-compra')) return;
      const abierto = li.querySelector('.pago-compra');
      if (abierto) { abierto.remove(); return; }
      li.append(formularioPagoCompra(x));
    });
    return li;
  }) : [linea('No debes nada a tus proveedores. 🎉', '')]));
}

function formularioPagoCompra(x) {
  const caja = Object.assign(document.createElement('div'), { className: 'pago-compra' });
  const pagos = Object.assign(document.createElement('ul'), { className: 'lista' });
  for (const g of x.pagos) {
    const p = linea(`${fechaPeru(g.fecha)} · ${g.cuenta ?? MEDIO_TEXTO[g.medio] ?? g.medio}`, g.anulado ? `anulado: ${g.anulado}` : soles(g.monto), g.anulado ? 'apagado' : '');
    if (!g.anulado && yo?.puedeAdministrar) {
      p.addEventListener('click', async () => {
        const motivo = prompt(`¿Anular el pago de ${soles(g.monto)}? Escribe el motivo:`);
        if (!motivo) return;
        try { await api(`/pagos-compra/${g.id}/anular`, { cuerpo: { motivo } }); await cargarPorPagar(); } catch (err) { alert(err.message); }
      });
    }
    pagos.append(p);
  }
  if (x.pagos.length) caja.append(pagos);
  const f = document.createElement('form');
  const medio = document.createElement('select');
  llenarMedios(medio);
  const monto = Object.assign(document.createElement('input'), { placeholder: `todo el saldo (${x.saldo})` });
  monto.setAttribute('inputmode', 'decimal');
  const referencia = Object.assign(document.createElement('input'), { placeholder: 'Nº de operación (opcional)', maxLength: 60 });
  const error = Object.assign(document.createElement('p'), { className: 'error' });
  const fila = Object.assign(document.createElement('div'), { className: 'fila' });
  const etiqueta = (texto, campo) => { const l = Object.assign(document.createElement('label'), { textContent: texto }); l.append(campo); return l; };
  fila.append(etiqueta('Monto', monto), etiqueta('Salió de', medio));
  f.append(fila, referencia, Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Registrar pago al proveedor' }), error);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/compras/${x.compraId}/pagos`, { cuerpo: {
        ...leerMedio(medio.value), ...(monto.value.trim() ? { monto: monto.value.trim().replace(',', '.') } : {}),
        ...(referencia.value.trim() ? { referencia: referencia.value.trim() } : {}),
      } });
      alert(r.saldo === '0.00' ? '✔ Compra pagada por completo.' : `✔ Pago registrado. Aún debes S/ ${r.saldo}.`);
      await Promise.all([cargarPorPagar(), cargarTablero()]);
    } catch (err) {
      error.textContent = err.message;
    }
  });
  caja.append(f);
  return caja;
}

async function alComprar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-compra').textContent = '';
  $('#ok-compra').textContent = '';
  const items = [...document.querySelectorAll('#items-compra .item')].map((fila) => ({
    descripcion: fila.querySelector('[name=descripcion]').value.trim(),
    cantidad: fila.querySelector('[name=cantidad]').value.trim().replace(',', '.'),
    costoUnitario: fila.querySelector('[name=costoUnitario]').value.trim().replace(',', '.'),
    sku: fila.querySelector('[name=sku]').value.trim(),
  }));
  try {
    await api('/compras', { cuerpo: {
      proveedor: { ruc: String(f.get('ruc')).trim(), razonSocial: String(f.get('razonSocial')).trim() },
      tipo: f.get('tipo'), serie: String(f.get('serie')).trim(), numero: String(f.get('numero')).trim(), fecha: f.get('fecha'),
      igv: String(f.get('igv')).trim().replace(',', '.'), total: String(f.get('total')).trim().replace(',', '.'), items,
      ...(f.get('condicion') === 'CREDITO' ? { vence: f.get('vence') } : {}),
    } });
    e.target.reset();
    $('#caja-vence-compra').hidden = true;
    $('#items-compra').replaceChildren();
    $('#ok-compra').textContent = '✔ Compra registrada. Su IGV ya se descuenta en el tablero.';
    await Promise.all([cargarCompras(), cargarTablero()]);
  } catch (err) {
    $('#error-compra').textContent = err.message;
  }
}

async function buscarProveedor(e) {
  const ruc = e.target.value.trim();
  const campo = $('#form-compra').razonSocial;
  if (!/^\d{11}$/.test(ruc) || campo.value.trim()) return;
  try { campo.value = (await api(`/proveedores?ruc=${ruc}`)).razonSocial; } catch { /* proveedor nuevo */ }
}

// ---------- Stock ----------
const ESTADO_STOCK = { AGOTADO: 'Agotado', PEDIR_YA: 'Pedir ya', PRONTO: 'Pedir pronto', OK: 'Bien', SIN_MOVIMIENTO: 'Sin movimiento' };
const fechaCorta = (iso) => DIA_MES.format(new Date(`${iso}T00:00:00Z`)).replace('.', '');

async function cargarReposicion() {
  const r = await api('/reposicion');
  const x = r.resumen;
  $('#kpis-inventario').replaceChildren(
    kpi('morado', 'Valor del inventario', soles(x.valorInventario), 'a costo promedio'),
    kpi(x.aPedir ? 'rosa' : 'verde', 'Por pedir', String(x.aPedir), x.agotados ? `${x.agotados} agotado(s)` : 'ninguno agotado'),
    kpi('azul', 'Días de inventario', x.diasDeInventario === null ? '—' : String(x.diasDeInventario), 'lo que dura al ritmo de venta'),
    kpi(x.sinMovimiento ? 'ambar' : 'gris', 'Sin movimiento', String(x.sinMovimiento), 'más de 60 días (dinero parado)'),
  );
  $('#lista-reposicion').replaceChildren(...(r.productos.length ? r.productos.map((p) => {
    const li = document.createElement('li');
    li.className = 'cliente';
    const d = document.createElement('details');
    const resumen = document.createElement('summary');
    const nombre = Object.assign(document.createElement('strong'), { textContent: `${p.nombre} · ${p.sku}` });
    const estado = Object.assign(document.createElement('span'), { className: `estado-plan ${p.estado}`, textContent: ESTADO_STOCK[p.estado] });
    const datos = document.createElement('div');
    datos.className = 'datos';
    const partes = [
      `Stock ${miles(p.stock)} · colchón ${p.colchon}`,
      p.estado === 'AGOTADO' ? 'sin stock' : p.diasQueAlcanza === null ? 'sin ventas en 30 días' : `alcanza ${p.diasQueAlcanza} día(s) (hasta el ${fechaCorta(p.seAgota)})`,
      p.sugerido !== '0' ? `👉 pedir ${p.sugerido}${p.proveedor ? ` a ${p.proveedor}` : ''}` : '',
      p.diasEntrega === null ? '⚠️ falta el tiempo de entrega' : `llega en ${p.diasEntrega} día(s)`,
    ];
    datos.textContent = partes.filter(Boolean).join(' · ');
    resumen.append(nombre, estado, datos);
    d.append(resumen);
    d.addEventListener('toggle', () => { if (d.open && !d.querySelector('.kardex')) verKardex(d, p.sku); });
    li.append(d);
    return li;
  }) : [linea('Aún no tienes productos con control de stock.', '')]));
  $('#lista-proveedores').replaceChildren(...(r.proveedores.length ? r.proveedores.map((v) => {
    const f = formulario([[`${v.razonSocial} · días `, entrada('dias', { value: v.diasEntrega ?? '', inputMode: 'numeric', required: true, maxLength: 3 })]],
      'Guardar', async (val) => {
        await api('/proveedores/dias', { cuerpo: { ruc: v.ruc, dias: val.dias } });
        setTimeout(cargarReposicion, 800);
        return '✔ Guardado.';
      });
    return f;
  }) : [Object.assign(document.createElement('p'), { className: 'vacio', textContent: 'Aún no hay proveedores: registra una compra.' })]));
}

async function verKardex(contenedor, sku) {
  const caja = document.createElement('div');
  caja.className = 'kardex';
  contenedor.append(caja);
  try {
    const k = await api(`/kardex?sku=${encodeURIComponent(sku)}`);
    const tabla = document.createElement('table');
    const cab = tabla.createTHead().insertRow();
    for (const t of ['Fecha', 'Movimiento', 'Documento', 'Entra', 'Sale', 'Saldo', 'Costo prom.', 'Valor']) cab.append(Object.assign(document.createElement('th'), { textContent: t }));
    const cuerpo = tabla.createTBody();
    for (const m of k.movimientos) {
      const fila = cuerpo.insertRow();
      for (const v of [m.fecha, m.tipo, m.documento || m.detalle || '', m.entrada || '', m.salida || '', m.saldo, m.costoPromedio || '', m.valorSaldo]) fila.insertCell().textContent = v;
    }
    const descargar = Object.assign(document.createElement('button'), { type: 'button', className: 'secundario', textContent: 'Descargar Kardex (Excel)' });
    descargar.addEventListener('click', async () => {
      const res = await api(`/kardex?sku=${encodeURIComponent(sku)}&formato=csv`, { crudo: true });
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'), { href: url, download: `kardex-${sku}.csv` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
    caja.append(k.movimientos.length ? tabla : Object.assign(document.createElement('p'), { className: 'vacio', textContent: 'Sin movimientos todavía.' }), descargar);
  } catch (err) {
    caja.textContent = err.message;
  }
}

async function cargarStock() {
  $('#caja-reposicion').hidden = !yo?.verInventario;
  if (yo?.verInventario) await cargarReposicion();
  // Con la reposición a la vista, la lista simple sobra (la sigue viendo el vendedor).
  $('#lista-stock').hidden = Boolean(yo?.verInventario);
  const { stock } = await api('/stock');
  $('#lista-stock').replaceChildren(...(stock.length ? stock.map((p) =>
    linea(`${p.sku} · ${p.nombre}`, `${p.stock} und.${p.minimo ? ` (mín. ${p.minimo})` : ''}`, p.bajoMinimo ? 'bajo' : ''))
    : [linea('Aún no tienes productos con stock.', '')]));
}

async function alGuardarProducto(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const msg = $('#mensaje-producto');
  try {
    await api('/productos', { cuerpo: {
      sku: f.get('sku'), nombre: f.get('nombre'), precio: String(f.get('precio')).trim().replace(',', '.'),
      controlaStock: f.get('controlaStock') === 'si', ...(f.get('stockMinimo') ? { stockMinimo: f.get('stockMinimo') } : {}),
      ...(f.get('codigoBarras') ? { codigoBarras: String(f.get('codigoBarras')).trim() } : {}),
    } });
    // Proveedor habitual y su tiempo de entrega (para saber cuándo pedir).
    if (f.get('proveedor') || f.get('diasEntrega')) {
      await api('/productos/proveedor', { cuerpo: { sku: f.get('sku'), ruc: f.get('proveedor'), dias: f.get('diasEntrega') } });
    }
    msg.className = '';
    msg.textContent = '✔ Producto guardado.';
    e.target.reset();
    await cargarStock();
    productos = (await api('/productos')).productos;
    $('#lista-productos').replaceChildren(...productos.map((p) => new Option(`S/ ${p.precio}`, p.nombre)));
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
}

async function alAjustar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const msg = $('#mensaje-ajuste');
  try {
    const r = await api('/stock/ajuste', { cuerpo: { sku: f.get('sku'), cantidad: String(f.get('cantidad')).replace('+', '').trim(), motivo: f.get('motivo') } });
    msg.className = '';
    msg.textContent = `✔ Stock actual: ${r.stock}`;
    e.target.reset();
    await cargarStock();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
}

function agregarCuota() {
  const nodo = $('#plantilla-cuota').content.cloneNode(true);
  nodo.querySelector('.quitar').addEventListener('click', (e) => {
    if (document.querySelectorAll('#cuotas .cuota').length > 1) e.target.closest('.cuota').remove();
  });
  $('#cuotas').appendChild(nodo);
}

/** Dibuja la imagen achicada (sin agrandar) para no subir la foto entera del celular. */
async function dibujarAchicada(archivo, anchoMax, altoMax) {
  const img = await createImageBitmap(archivo);
  const escala = Math.min(1, anchoMax / img.width, altoMax / img.height);
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(img.width * escala);
  lienzo.height = Math.round(img.height * escala);
  lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
  return lienzo;
}

/** Foto de un recibo: JPG de hasta 1400 px; baja la calidad hasta que pese menos de ~330 KB. */
async function fotoRecibo(archivo) {
  const lienzo = await dibujarAchicada(archivo, 1400, 1400);
  for (const calidad of [0.75, 0.6, 0.45, 0.3]) {
    const datos = lienzo.toDataURL('image/jpeg', calidad);
    if (datos.length < 450_000) return datos;
  }
  throw new Error('La foto es muy pesada aun achicada. Prueba con otra.');
}

// Logo: se achica en el navegador (máx. 600×300) para que pese poco y cargue rápido en el PDF.
async function subirLogo(e) {
  const archivo = e.target.files?.[0];
  const msg = $('#mensaje-logo');
  if (!archivo) return;
  try {
    const lienzo = await dibujarAchicada(archivo, 600, 300);
    let datos = lienzo.toDataURL('image/png');
    if (datos.length > 90_000) datos = lienzo.toDataURL('image/jpeg', 0.85);
    await api('/logo', { cuerpo: { imagen: datos } });
    msg.className = '';
    msg.textContent = '✔ Logo actualizado. Abre el PDF de un comprobante para verlo.';
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message || 'No se pudo leer la imagen.';
  } finally {
    e.target.value = '';
  }
}

function mensaje(selector, texto, error = false) {
  const p = $(selector);
  p.className = error ? 'error' : '';
  p.textContent = texto;
}

const leerBase64 = (archivo) => new Promise((ok, falla) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result));
  r.onerror = () => falla(new Error('No se pudo leer el archivo.'));
  r.readAsDataURL(archivo);
});
