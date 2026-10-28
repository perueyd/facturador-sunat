// Panel del facturador. Sin librerías: es una sola página que habla con /panel/api.
//
// Regla de dinero: los montos viajan como TEXTO ("59.90") y el total que se ve aquí se
// calcula en céntimos enteros (BigInt), nunca con números de JavaScript. El total que
// vale es el del facturador, que se muestra al emitir.
'use strict';

const $ = (sel) => document.querySelector(sel);
const ESTADOS = {
  EMITIDO_LOCAL: 'en cola para SUNAT',
  PENDIENTE_ENVIO: 'en cola para SUNAT (se reintenta solo)',
  ACEPTADO: 'aceptado por SUNAT',
  ACEPTADO_OBS: 'aceptado por SUNAT (con observaciones)',
  RECHAZADO: 'RECHAZADO por SUNAT',
  ANULACION_EN_PROCESO: 'anulación en proceso',
  ANULADO: 'anulado',
};

async function api(ruta, opciones = {}) {
  const res = await fetch(`/panel/api${ruta}`, {
    method: opciones.metodo || (opciones.cuerpo ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
    credentials: 'same-origin',
    ...(opciones.cuerpo ? { body: JSON.stringify(opciones.cuerpo) } : {}),
  });
  if (opciones.crudo) return res;
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401 && ruta !== '/entrar' && !ruta.startsWith('/instalacion') && !ruta.startsWith('/recuperar')) mostrarEntrar();
  if (!res.ok) {
    const e = new Error(datos.error?.mensaje || 'No se pudo completar. Intenta de nuevo.');
    e.detalles = datos.error?.detalles || [];
    throw e;
  }
  return datos;
}

// ---------- Céntimos exactos ----------
function aCentimos(texto) {
  const t = String(texto).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [entero, dec = ''] = t.split('.');
  return BigInt(entero) * 100n + BigInt((dec + '00').slice(0, 2));
}
const textoSoles = (c) => `S/ ${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

function recalcularTotal() {
  let total = 0n;
  for (const fila of document.querySelectorAll('#items .item')) {
    const textoPrecio = fila.querySelector('[name=precio]').value;
    const precio = textoPrecio.trim() === '' ? 0n : aCentimos(textoPrecio);
    const cantidad = fila.querySelector('[name=cantidad]').value.trim();
    // Cantidades con decimales: el total exacto lo da el facturador al emitir.
    if (precio === null || !/^\d+$/.test(cantidad)) { $('#total').textContent = 'se calcula al emitir'; return; }
    total += precio * BigInt(cantidad);
  }
  $('#total').textContent = textoSoles(total);
}

function agregarItem() {
  const nodo = $('#plantilla-item').content.cloneNode(true);
  nodo.querySelector('.quitar').addEventListener('click', (e) => {
    if (document.querySelectorAll('#items .item').length > 1) e.target.closest('.item').remove();
    recalcularTotal();
  });
  for (const input of nodo.querySelectorAll('input')) input.addEventListener('input', recalcularTotal);
  // Producto guardado: al elegirlo de la lista se pone su precio.
  nodo.querySelector('[name=descripcion]').addEventListener('change', (e) => {
    const p = productos.find((x) => x.nombre === e.target.value);
    if (p) {
      e.target.closest('.item').querySelector('[name=precio]').value = p.precio;
      recalcularTotal();
    }
  });
  $('#items').appendChild(nodo);
}

// ---------- Vistas ----------
function mostrarEntrar() {
  $('#vista-instalar').hidden = true;
  $('#vista-recuperar').hidden = true;
  $('#vista-entrar').hidden = false;
  // Facturador recién publicado, sin usuarios: se ofrece la primera configuración.
  api('/instalacion').then((r) => { $('#enlace-instalar').hidden = !r.disponible; }).catch(() => {});
  $('#vista-panel').hidden = true;
  $('#salir').hidden = true;
  $('#quien').textContent = '';
}

let pedidoActual = nuevoPedido();
function nuevoPedido() {
  // Se genera al abrir el formulario y se manda al emitir: si se pulsa dos veces o se
  // corta la conexión y se reintenta, el facturador devuelve el mismo comprobante.
  return `PANEL-${crypto.randomUUID()}`;
}

let yo = null;
let productos = [];
const tiene = (modulo) => Boolean(yo?.empresa?.modulos?.includes(modulo));

async function cargarPanel() {
  yo = await api('/yo');
  $('#vista-entrar').hidden = true;
  $('#vista-panel').hidden = false;
  $('#salir').hidden = false;
  $('#quien').textContent = yo.nombre;

  const sel = $('#empresa');
  sel.replaceChildren(...yo.empresas.map((e) => new Option(`${e.razonSocial} (${e.ruc})`, e.id, false, e.id === yo.empresa?.id)));
  $('#caja-empresa').hidden = yo.empresas.length < 2;
  $('#aviso-beta').hidden = yo.empresa?.ambiente !== 'BETA';

  $('#canal').replaceChildren(...yo.canales.map((c) => new Option(c, c)));
  $('#form-emitir').hidden = !yo.puedeEmitir;
  $('#sin-permiso').hidden = yo.puedeEmitir;
  $('#caja-exportar').hidden = !tiene('exportar');
  for (const b of document.querySelectorAll('#pestanas button')) {
    const modulo = b.dataset.modulo;
    b.hidden = (modulo && !tiene(modulo)) || (b.dataset.pestana === 'compras' && !yo.puedeComprar);
  }
  $('#caja-producto').hidden = !yo.puedeAdministrar;
  $('#caja-logo').hidden = !yo.puedeAdministrar;
  $('#caja-usuarios').hidden = !yo.esDueno;
  $('#caja-certificado').hidden = !yo.esDueno;
  $('#caja-empresa-nueva').hidden = !yo.adminPlataforma;
  $('#caja-ajuste').hidden = !yo.puedeAdministrar;
  if (!$('#mes-exportar').value) $('#mes-exportar').value = new Date().toISOString().slice(0, 7);
  productos = tiene('productos') ? (await api('/productos').catch(() => ({ productos: [] }))).productos : [];
  $('#lista-productos').replaceChildren(...productos.map((p) => new Option(`S/ ${p.precio}`, p.nombre)));
  await Promise.all([cargarTablero(), cargarLista()]);
}

// ---------- Tablero ----------
function tarjeta(titulo, valor, detalle, clase = '') {
  const t = document.createElement('div');
  t.className = `tarjeta ${clase}`;
  const v = document.createElement('strong');
  v.textContent = valor;
  t.append(titulo, v);
  if (detalle) t.append(detalle);
  return t;
}

const FECHA = new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const fechaLarga = (iso) => FECHA.format(new Date(`${iso}T00:00:00Z`));

async function cargarTablero() {
  const t = await api('/tablero');
  const tarjetas = [];
  const v = t.vencimiento;
  if (v?.faltaCronograma) {
    tarjetas.push(tarjeta('Declaración mensual', 'Falta el cronograma', 'Carga el cronograma de SUNAT de este año.', 'ancha urgente'));
  } else if (v) {
    const dias = v.dias === 0 ? '¡vence HOY!' : v.dias === 1 ? 'vence MAÑANA' : `quedan ${v.dias} días`;
    tarjetas.push(tarjeta(`Declarar y pagar ${v.nombre} (IGV y Renta)`, `${fechaLarga(v.vence)} · ${dias}`,
      `Según el último dígito de tu RUC (${v.grupo}). Fuente: cronograma oficial SUNAT.`, `ancha ${v.dias <= 3 ? 'urgente' : ''}`));
  }
  const r = t.resumen;
  if (r) {
    const tabla = document.createElement('table');
    const filas = [
      ['Ventas del mes (con IGV)', r.ventas],
      ['IGV cobrado en ventas', r.igvVentas],
      ['IGV de tus compras', r.igvCompras],
      ...(r.saldoAFavor !== '0.00' ? [['Saldo a favor (estimado)', r.saldoAFavor]] : []),
      ...(r.rentaPagoCuenta ? [[`Renta, pago a cuenta ${r.rentaPagoCuenta.tasa}% (estimado)`, r.rentaPagoCuenta.monto]] : []),
    ];
    for (const [a, b] of filas) {
      const tr = tabla.insertRow();
      tr.insertCell().textContent = a;
      tr.insertCell().textContent = `S/ ${b}`;
    }
    tarjetas.push(tarjeta(`${r.nombre}: IGV estimado a pagar`, `S/ ${r.igvPorPagar}`, tabla, 'ancha'));
  }
  if (t.certificado?.falta) {
    tarjetas.push(tarjeta('Certificado digital', 'No cargado', 'Sin él no se puede emitir.', 'urgente'));
  } else if (t.certificado) {
    const c = t.certificado;
    tarjetas.push(tarjeta('Certificado digital', c.dias < 0 ? 'VENCIDO' : `vence en ${c.dias} días`, c.vence, c.dias <= 30 ? 'urgente' : 'ok'));
  }
  if (t.sunat) {
    const problemas = t.sunat.rechazados > 0;
    tarjetas.push(tarjeta('SUNAT', problemas ? `${t.sunat.rechazados} rechazado(s)` : t.sunat.pendientes ? `${t.sunat.pendientes} en cola` : 'Todo enviado',
      problemas ? 'Revísalos en la lista de abajo.' : t.sunat.pendientes ? 'Se envían solos.' : '', problemas ? 'urgente' : 'ok'));
  }
  if (t.cobros) {
    tarjetas.push(tarjeta('Por cobrar', `S/ ${t.cobros.saldo}`, `${t.cobros.comprobantes} comprobante(s)`));
  }
  $('#tablero').replaceChildren(...tarjetas);
  $('#nota-estimado').hidden = !r;
}

async function cargarLista() {
  const { comprobantes } = await api('/comprobantes');
  $('#lista').replaceChildren(...comprobantes.map((c) => {
    const li = document.createElement('li');
    const izq = document.createElement('span');
    izq.textContent = `${c.numero} · ${c.cliente}`;
    const der = document.createElement('span');
    der.textContent = `S/ ${c.total} `;
    const estado = document.createElement('span');
    estado.className = `estado ${c.estado}`;
    estado.textContent = ESTADOS[c.estado] || c.estado;
    der.appendChild(estado);
    li.append(izq, der);
    li.addEventListener('click', () => verComprobante(c.id));
    return li;
  }));
}

async function verComprobante(id) {
  try {
    mostrarResultado(await api(`/comprobantes/${id}`));
  } catch (e) {
    alert(e.message);
  }
}

function boton(texto, alPulsar) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'secundario';
  b.textContent = texto;
  b.addEventListener('click', alPulsar);
  return b;
}

async function abrirPdf(id, formato) {
  const ventana = window.open('', '_blank');
  const res = await api(`/comprobantes/${id}/pdf?formato=${formato}`, { crudo: true });
  if (!res.ok) {
    ventana?.close();
    const d = await res.json().catch(() => ({}));
    alert(d.error?.mensaje || 'No se pudo abrir el PDF.');
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  if (ventana) ventana.location.href = url; else window.location.href = url;
}

function mostrarResultado(c) {
  const caja = $('#resultado');
  const titulo = document.createElement('p');
  const fuerte = document.createElement('strong');
  fuerte.textContent = `${c.numero} · S/ ${c.total}`;
  titulo.append(fuerte, ` — ${ESTADOS[c.estado] || c.estado}${c.repetido ? ' (ya estaba emitido)' : ''}`);
  const partes = [titulo];
  if (c.sunat?.mensaje && c.estado === 'RECHAZADO') {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `SUNAT: ${c.sunat.mensaje}`;
    partes.push(p);
  }
  if (c.errorPago) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `El comprobante salió, pero el pago no se registró: ${c.errorPago}`;
    partes.push(p);
  }
  const botones = document.createElement('div');
  botones.className = 'botones';
  botones.append(boton('PDF A4', () => abrirPdf(c.id, 'A4')), boton('Ticket', () => abrirPdf(c.id, 'TICKET_80')));
  if (c.enlaces?.cliente) {
    botones.append(boton('Enviar por WhatsApp', () => {
      const texto = `Hola, aquí está tu comprobante ${c.numero}: ${c.enlaces.cliente}`;
      window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
    }));
    botones.append(boton('Copiar enlace', () => navigator.clipboard?.writeText(c.enlaces.cliente)));
  }
  if (tiene('cobros') && c.tipo !== '07' && c.saldo && c.saldo !== '0.00' && c.estado !== 'RECHAZADO') {
    botones.append(boton(`Registrar cobro (saldo S/ ${c.saldo})`, () => abrirCobro({ id: c.id, numero: c.numero, saldo: c.saldo })));
  }
  // Corregir: devolución total (nota de crédito) o anulación. Solo dueño/administrador.
  if (yo?.puedeCorregir && c.tipo !== '07' && (c.estado === 'ACEPTADO' || c.estado === 'ACEPTADO_OBS')) {
    const corregir = boton('Devolución total (nota de crédito)', async () => {
      const motivo = prompt('Motivo de la devolución (lo verá SUNAT):', 'Devolución del cliente');
      if (!motivo) return;
      try { mostrarResultado(await api(`/comprobantes/${c.id}/devolucion`, { cuerpo: { motivo } })); await cargarPanel(); }
      catch (err) { alert(err.message); }
    });
    corregir.classList.add('peligro');
    const anular = boton('Anular (error al emitir)', async () => {
      const motivo = prompt('¿Por qué se anula? (máx. 100 caracteres)', 'Error en la emisión');
      if (!motivo) return;
      try {
        const r = await api(`/comprobantes/${c.id}/anular`, { cuerpo: { motivo } });
        alert(`Anulación enviada a SUNAT (${r.documento}). En unos minutos se confirma.`);
        await cargarPanel();
      } catch (err) { alert(err.message); }
    });
    anular.classList.add('peligro');
    botones.append(corregir, anular);
  }
  partes.push(botones);
  caja.replaceChildren(...partes);
  caja.hidden = false;
  caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Primera configuración ----------
let instalacion = null;
async function alInstalar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-instalar').textContent = '';
  try {
    const r = await api('/instalacion', { cuerpo: Object.fromEntries(f) });
    instalacion = { clave: f.get('clave'), usuarioId: r.usuarioId, email: f.get('email') };
    $('#qr-instalar').src = r.qr;
    $('#clave-instalar').textContent = r.clave;
    $('#abrir-app').href = r.url;
    e.target.hidden = true;
    $('#form-instalar-codigo').hidden = false;
  } catch (err) {
    $('#error-instalar').textContent = err.message;
  }
}

async function alActivarInstalacion(e) {
  e.preventDefault();
  $('#error-instalar-codigo').textContent = '';
  try {
    await api('/instalacion/activar', { cuerpo: { ...instalacion, codigo: new FormData(e.target).get('codigo') } });
    alert('✔ Listo. Ahora entra con tu correo, tu contraseña y el código del momento.');
    const correo = instalacion.email;
    instalacion = null;
    mostrarEntrar();
    $('#form-entrar').email.value = correo;
  } catch (err) {
    $('#error-instalar-codigo').textContent = err.message;
  }
}

// ---------- Recuperar el acceso ----------
let recuperacion = null;
async function alRecuperar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-recuperar').textContent = '';
  try {
    const r = await api('/recuperar', { cuerpo: Object.fromEntries(f) });
    recuperacion = { clave: f.get('clave'), email: f.get('email') };
    $('#qr-recuperar').src = r.qr;
    $('#clave-recuperar').textContent = r.clave;
    $('#abrir-app-recuperar').href = r.url;
    e.target.hidden = true;
    $('#form-recuperar-codigo').hidden = false;
  } catch (err) {
    $('#error-recuperar').textContent = err.message;
  }
}

async function alActivarRecuperacion(e) {
  e.preventDefault();
  $('#error-recuperar-codigo').textContent = '';
  try {
    await api('/recuperar/activar', { cuerpo: { ...recuperacion, codigo: new FormData(e.target).get('codigo') } });
    alert('✔ Acceso recuperado. Entra con tu contraseña nueva y el código del momento. Luego borra CLAVE_RECUPERACION de Render.');
    const correo = recuperacion.email;
    recuperacion = null;
    $('#form-recuperar').hidden = false;
    $('#form-recuperar').reset();
    $('#form-recuperar-codigo').hidden = true;
    mostrarEntrar();
    $('#form-entrar').email.value = correo;
  } catch (err) {
    $('#error-recuperar-codigo').textContent = err.message;
  }
}

// ---------- Formularios ----------
async function alEntrar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-entrar').textContent = '';
  try {
    await api('/entrar', { cuerpo: { email: f.get('email'), contrasena: f.get('contrasena'), codigo: f.get('codigo'), recordar: f.get('recordar') === 'on' } });
    e.target.reset();
    await cargarPanel();
  } catch (err) {
    $('#error-entrar').textContent = err.message;
  }
}

async function alEmitir(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const items = [...document.querySelectorAll('#items .item')].map((fila) => ({
    descripcion: fila.querySelector('[name=descripcion]').value.trim(),
    cantidad: fila.querySelector('[name=cantidad]').value.trim().replace(',', '.'),
    precio: fila.querySelector('[name=precio]').value.trim().replace(',', '.'),
  }));
  const tipoDocumento = f.get('tipoDocumento');
  const cuerpo = {
    pedido: pedidoActual,
    canal: f.get('canal'),
    tipo: f.get('tipo'),
    items,
    ...(tipoDocumento !== 'NINGUNO' || f.get('nombre')
      ? { cliente: { tipoDocumento, numero: String(f.get('numero')).trim(), nombre: String(f.get('nombre')).trim() } }
      : {}),
    ...(f.get('medio') ? { pago: { medio: f.get('medio'), ...(f.get('referencia') ? { referencia: f.get('referencia') } : {}) } } : {}),
    ...(f.get('formaPago') === 'CREDITO'
      ? { formaPago: { cuotas: [...document.querySelectorAll('#cuotas .cuota')].map((q) => ({
          monto: q.querySelector('[name=monto]').value.trim().replace(',', '.'), vence: q.querySelector('[name=vence]').value,
        })) } }
      : {}),
  };
  const b = $('#boton-emitir');
  b.disabled = true;
  b.textContent = 'Emitiendo...';
  $('#error-emitir').textContent = '';
  try {
    const c = await api('/comprobantes', { cuerpo });
    mostrarResultado(c);
    // Listo: el siguiente comprobante es otro pedido.
    pedidoActual = nuevoPedido();
    e.target.reset();
    $('#items').replaceChildren();
    $('#cuotas').replaceChildren();
    $('#caja-cuotas').hidden = true;
    $('#opcion-credito').disabled = true;
    agregarItem();
    recalcularTotal();
    await Promise.all([cargarLista(), cargarTablero()]);
  } catch (err) {
    $('#error-emitir').textContent = [err.message, ...(err.detalles || [])].join('\n');
  } finally {
    b.disabled = false;
    b.textContent = 'Emitir';
  }
}

// ---------- Pestañas ----------
async function abrirPestana(nombre) {
  for (const b of document.querySelectorAll('#pestanas button')) b.classList.toggle('activa', b.dataset.pestana === nombre);
  for (const v of document.querySelectorAll('[data-vista]')) v.hidden = v.dataset.vista !== nombre;
  try {
    if (nombre === 'cobrar') await cargarPorCobrar();
    if (nombre === 'compras') await cargarCompras();
    if (nombre === 'stock') await cargarStock();
    if (nombre === 'mas') await cargarUsuarios();
  } catch (err) { alert(err.message); }
}

function linea(texto, derecha, clase = '') {
  const li = document.createElement('li');
  if (clase) li.className = clase;
  const a = document.createElement('span');
  a.textContent = texto;
  const b = document.createElement('span');
  b.textContent = derecha;
  li.append(a, b);
  return li;
}

// ---------- Cobrar ----------
let cobroActual = null;
async function cargarPorCobrar() {
  const { porCobrar } = await api('/por-cobrar');
  $('#lista-cobrar').replaceChildren(...(porCobrar.length ? porCobrar.map((x) => {
    const li = linea(`${x.numero} · ${x.cliente}`, `S/ ${x.saldo}${x.proximaCuota ? ` · cuota ${x.proximaCuota}` : ''}`);
    li.addEventListener('click', () => abrirCobro(x));
    return li;
  }) : [linea('Nadie te debe. 🎉', '')]));
  $('#form-cobro').hidden = true;
}

async function abrirCobro(x) {
  cobroActual = x;
  if ($('[data-vista=cobrar]').hidden) await abrirPestana('cobrar');
  $('#cobro-titulo').textContent = `${x.numero} — saldo S/ ${x.saldo}`;
  $('#form-cobro').hidden = false;
  $('#form-cobro').scrollIntoView({ behavior: 'smooth' });
}

async function alCobrar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-cobro').textContent = '';
  try {
    const c = await api(`/comprobantes/${cobroActual.id}/pagos`, { cuerpo: {
      medio: f.get('medio'), ...(f.get('monto') ? { monto: String(f.get('monto')).trim().replace(',', '.') } : {}),
      ...(f.get('referencia') ? { referencia: f.get('referencia') } : {}),
    } });
    e.target.reset();
    alert(`Cobro registrado. Saldo de ${c.numero}: S/ ${c.saldo}`);
    await Promise.all([cargarPorCobrar(), cargarTablero()]);
  } catch (err) {
    $('#error-cobro').textContent = err.message;
  }
}

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
  $('#lista-compras').replaceChildren(...compras.map((x) => linea(`${x.fecha} · ${x.numero} · ${x.proveedor}`, `S/ ${x.total} (IGV ${x.igv})`)));
  if (!$('#items-compra').children.length) agregarLineaCompra();
  if (!$('#form-compra').fecha.value) $('#form-compra').fecha.value = new Date().toISOString().slice(0, 10);
  if (tiene('productos')) {
    const { stock } = await api('/stock');
    $('#lista-skus').replaceChildren(...stock.map((p) => new Option(p.nombre, p.sku)));
  }
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
    } });
    e.target.reset();
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
async function cargarStock() {
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
    } });
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

// Logo: se achica en el navegador (máx. 600×300) para que pese poco y cargue rápido en el PDF.
async function subirLogo(e) {
  const archivo = e.target.files?.[0];
  const msg = $('#mensaje-logo');
  if (!archivo) return;
  try {
    const img = await createImageBitmap(archivo);
    const escala = Math.min(1, 600 / img.width, 300 / img.height);
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.round(img.width * escala);
    lienzo.height = Math.round(img.height * escala);
    lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
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

// ---------- Usuarios, certificado y empresas ----------
let usuarioPorActivar = null;
async function cargarUsuarios() {
  if (!yo?.esDueno) return;
  const { usuarios } = await api('/usuarios');
  $('#lista-usuarios').replaceChildren(...usuarios.map((u) =>
    linea(`${u.nombre} · ${u.email}`, `${u.rol}${u.activo ? '' : ' · desactivado'}${u.dosPasos ? '' : ' · falta activar'}`)));
}

async function alDarAcceso(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/usuarios', { cuerpo: { email: f.get('email'), rol: f.get('rol'), nombre: f.get('nombre'), contrasena: f.get('contrasena') } });
    e.target.reset();
    if (r.existente) {
      mensaje('#mensaje-usuario', '✔ Ya tenía cuenta: ahora también tiene acceso a esta empresa.');
    } else {
      usuarioPorActivar = r.usuarioId;
      $('#qr-usuario').src = r.qr;
      $('#clave-usuario').textContent = r.clave;
      $('#form-activar').hidden = false;
      mensaje('#mensaje-usuario', '');
    }
    await cargarUsuarios();
  } catch (err) {
    mensaje('#mensaje-usuario', err.message, true);
  }
}

async function alActivar(e) {
  e.preventDefault();
  try {
    await api(`/usuarios/${usuarioPorActivar}/activar`, { cuerpo: { codigo: new FormData(e.target).get('codigo') } });
    e.target.reset();
    $('#form-activar').hidden = true;
    $('#qr-usuario').removeAttribute('src');
    mensaje('#mensaje-usuario', '✔ Usuario activado: ya puede entrar al panel.');
    await cargarUsuarios();
  } catch (err) {
    mensaje('#mensaje-activar', err.message, true);
  }
}

async function alCargarCertificado(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('/certificado', { cuerpo: { pfx: await leerBase64(f.get('archivo')), clave: f.get('clave') } });
    e.target.reset();
    mensaje('#mensaje-certificado', `✔ Certificado cargado. Vence el ${r.vence}.`);
    await cargarTablero();
  } catch (err) {
    mensaje('#mensaje-certificado', err.message, true);
  }
}

async function alCrearEmpresa(e) {
  e.preventDefault();
  const datos = Object.fromEntries(new FormData(e.target));
  try {
    await api('/empresas', { cuerpo: datos });
    e.target.reset();
    mensaje('#mensaje-empresa', '✔ Empresa creada. Ahora carga su certificado digital aquí arriba.');
    await cargarPanel();
  } catch (err) {
    mensaje('#mensaje-empresa', err.message, true);
  }
}

async function exportar() {
  const mes = $('#mes-exportar').value;
  const res = await api(`/exportar?mes=${encodeURIComponent(mes)}`, { crudo: true });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error?.mensaje || 'No se pudo exportar.'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `ventas-${mes}.csv`;
  a.click();
}

async function alCambiarContrasena(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const msg = $('#mensaje-contrasena');
  try {
    await api('/contrasena', { cuerpo: { actual: f.get('actual'), nueva: f.get('nueva'), codigo: f.get('codigo') } });
    msg.className = '';
    msg.textContent = '✔ Contraseña cambiada. Se cerraron tus otras sesiones.';
    e.target.reset();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
}

// Cliente ya conocido: al escribir su DNI o RUC se completa el nombre.
async function buscarCliente(e) {
  const doc = e.target.value.trim();
  const nombre = $('[name=nombre]');
  if (!/^\d{8}$|^\d{11}$/.test(doc) || nombre.value.trim()) return;
  try { nombre.value = (await api(`/clientes?doc=${doc}`)).nombre; } catch { /* cliente nuevo */ }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#exportar').addEventListener('click', exportar);
  $('#cerrar-otras').addEventListener('click', async () => {
    try {
      const r = await api('/sesiones/cerrar-otras', { cuerpo: {} });
      mensaje('#mensaje-sesiones', r.cerradas ? `✔ Se cerraron ${r.cerradas} sesión(es) en otros dispositivos.` : 'No había otras sesiones abiertas.');
    } catch (err) {
      mensaje('#mensaje-sesiones', err.message, true);
    }
  });
  $('#archivo-logo').addEventListener('change', subirLogo);
  $('#form-usuario').addEventListener('submit', alDarAcceso);
  $('#form-activar').addEventListener('submit', alActivar);
  $('#form-certificado').addEventListener('submit', alCargarCertificado);
  $('#form-empresa').addEventListener('submit', alCrearEmpresa);
  for (const b of document.querySelectorAll('#pestanas button')) b.addEventListener('click', () => abrirPestana(b.dataset.pestana));
  $('#forma-pago').addEventListener('change', (e) => {
    $('#caja-cuotas').hidden = e.target.value !== 'CREDITO';
    if (e.target.value === 'CREDITO' && !$('#cuotas').children.length) agregarCuota();
  });
  $('#agregar-cuota').addEventListener('click', agregarCuota);
  // El crédito en cuotas solo existe para facturas (lo valida también el facturador).
  $('#form-emitir').tipo.addEventListener('change', (e) => {
    const factura = e.target.value === 'FACTURA';
    $('#opcion-credito').disabled = !factura;
    if (!factura && $('#forma-pago').value === 'CREDITO') {
      $('#forma-pago').value = 'CONTADO';
      $('#caja-cuotas').hidden = true;
    }
  });
  $('#form-cobro').addEventListener('submit', alCobrar);
  $('#form-compra').addEventListener('submit', alComprar);
  $('#form-compra').ruc.addEventListener('change', buscarProveedor);
  $('#agregar-compra').addEventListener('click', agregarLineaCompra);
  $('#form-producto').addEventListener('submit', alGuardarProducto);
  $('#form-ajuste').addEventListener('submit', alAjustar);
  $('#form-contrasena').addEventListener('submit', alCambiarContrasena);
  $('[name=numero]').addEventListener('change', buscarCliente);
  $('#form-entrar').addEventListener('submit', alEntrar);
  $('#ir-instalar').addEventListener('click', () => { $('#vista-entrar').hidden = true; $('#vista-instalar').hidden = false; });
  $('#form-instalar').addEventListener('submit', alInstalar);
  $('#ir-recuperar').addEventListener('click', () => { $('#vista-entrar').hidden = true; $('#vista-recuperar').hidden = false; });
  $('#volver-entrar').addEventListener('click', mostrarEntrar);
  $('#form-recuperar').addEventListener('submit', alRecuperar);
  $('#form-recuperar-codigo').addEventListener('submit', alActivarRecuperacion);
  $('#form-instalar-codigo').addEventListener('submit', alActivarInstalacion);
  $('#form-emitir').addEventListener('submit', alEmitir);
  $('#agregar').addEventListener('click', () => { agregarItem(); recalcularTotal(); });
  $('#salir').addEventListener('click', async () => { await api('/salir', { cuerpo: {} }).catch(() => {}); mostrarEntrar(); });
  $('#empresa').addEventListener('change', async (e) => {
    await api('/empresa', { cuerpo: { empresaId: e.target.value } });
    pedidoActual = nuevoPedido();
    $('#resultado').hidden = true;
    await cargarPanel();
  });
  agregarItem();
  cargarPanel().catch(mostrarEntrar);
});
