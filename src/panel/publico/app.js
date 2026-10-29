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
  $('#vista-enlace').hidden = true;
  $('#vista-codigos').hidden = true;
  $('#vista-entrar').hidden = false;
  $('#form-entrar').codigo.inputMode = 'numeric';
  $('#etiqueta-codigo').textContent = 'Código de 6 dígitos (de tu app autenticadora)';
  $('#usar-respaldo').hidden = false;
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
  $('#boton-plataforma').hidden = !yo.adminPlataforma;
  mostrarPlan(yo.plan);
  // Sin códigos de respaldo, perder el celular obliga a usar la llave de la tienda: se avisa.
  $('#estado-respaldo').textContent = yo.codigosRespaldo
    ? `Te quedan ${yo.codigosRespaldo} códigos sin usar.`
    : '⚠️ No tienes códigos de respaldo: genéralos ahora por si pierdes el celular.';
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
  const sinEstadisticas = () => { $('#kpis').hidden = true; $('#graficos').hidden = true; };
  if (yo?.verEstadisticas) cargarEstadisticas().catch(sinEstadisticas); else sinEstadisticas();
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

// ---------- Estadísticas de ventas ----------
// Los montos llegan como texto ("11848.00") y se muestran tal cual, con separador de miles.
// El alto de cada barra (0 a 100) ya viene calculado por el facturador: aquí no se suma nada.
const miles = (texto) => texto.replace(/^(-?\d+)/, (ent) => ent.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const soles = (texto) => `S/ ${miles(texto)}`;
/** "11848.00" → "11.8 mil" (para las etiquetas pequeñas de los gráficos). */
function corto(texto) {
  const ent = texto.split('.')[0].replace('-', '');
  const signo = texto.startsWith('-') ? '-' : '';
  if (ent.length <= 3) return signo + ent;
  if (ent.length >= 7) return `${signo}${ent.slice(0, -6)} M`;
  const decimal = ent.slice(-3, -2);
  return `${signo}${ent.slice(0, -3)}${decimal === '0' ? '' : `.${decimal}`} mil`;
}
const NS = 'http://www.w3.org/2000/svg';
function svg(etiqueta, atributos, texto) {
  const e = document.createElementNS(NS, etiqueta);
  for (const [k, v] of Object.entries(atributos)) e.setAttribute(k, v);
  if (texto !== undefined) e.textContent = texto;
  return e;
}
const DIA_MES = new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const diaCorto = (iso) => DIA_MES.format(new Date(`${iso}T00:00:00Z`)).replace('.', '');

function kpi(color, titulo, valor, detalle) {
  const k = document.createElement('div');
  k.className = `kpi ${color}`;
  const b = document.createElement('b');
  b.textContent = titulo;
  const v = document.createElement('strong');
  v.textContent = valor;
  k.append(b, v);
  if (detalle) k.append(detalle);
  return k;
}

function graficoMeses(meses) {
  const conCompras = meses.some((m) => m.compras !== undefined);
  const caja = $('#graf-meses');
  const ancho = 320 / meses.length;
  const hijos = [svg('line', { x1: 0, y1: 140, x2: 320, y2: 140, stroke: '#e5e5e5' })];
  meses.forEach((m, i) => {
    const x = i * ancho;
    const barra = (alto, dx, w, color, titulo) => {
      const r = svg('rect', { x: x + dx, y: 140 - alto * 1.15, width: w, height: Math.max(alto * 1.15, alto ? 1 : 0), rx: 3, fill: color });
      r.append(svg('title', {}, titulo));
      return r;
    };
    if (conCompras) {
      hijos.push(barra(m.alto, ancho / 2 - 15, 14, '#17b897', `${m.nombre}: ventas ${soles(m.ventas)}`));
      hijos.push(barra(m.altoCompras, ancho / 2 + 1, 14, '#f472a8', `${m.nombre}: compras ${soles(m.compras)}`));
    } else {
      hijos.push(barra(m.alto, ancho / 2 - 13, 26, '#17b897', `${m.nombre}: ${soles(m.ventas)}`));
    }
    if (m.ventas !== '0.00') hijos.push(svg('text', { x: x + ancho / 2, y: 140 - m.alto * 1.15 - 4, 'text-anchor': 'middle' }, corto(m.ventas)));
    hijos.push(svg('text', { x: x + ancho / 2, y: 155, 'text-anchor': 'middle' }, m.nombre));
  });
  caja.replaceChildren(...hijos);
  $('#leyenda-compras').hidden = !conCompras;
}

function graficoDias(dias) {
  const ancho = 320 / dias.length;
  const hijos = [svg('line', { x1: 0, y1: 105, x2: 320, y2: 105, stroke: '#e5e5e5' })];
  dias.forEach((d, i) => {
    const ultimo = i === dias.length - 1;
    const r = svg('rect', { x: i * ancho + 1, y: 105 - d.alto * 0.95, width: ancho - 2, height: Math.max(d.alto * 0.95, d.alto ? 1 : 0), rx: 2, fill: ultimo ? '#7c4dde' : '#a26bf0' });
    r.append(svg('title', {}, `${diaCorto(d.fecha)}: ${soles(d.ventas)}`));
    hijos.push(r);
  });
  for (const i of [0, 14, dias.length - 1]) {
    hijos.push(svg('text', { x: i * ancho + ancho / 2, y: 120, 'text-anchor': i === 0 ? 'start' : i === dias.length - 1 ? 'end' : 'middle' }, i === dias.length - 1 ? 'hoy' : diaCorto(dias[i].fecha)));
  }
  $('#graf-dias').replaceChildren(...hijos);
  const mejor = dias.find((d) => d.alto === 100);
  $('#dia-mejor').textContent = mejor ? `Mejor día: ${diaCorto(mejor.fecha)} · ${soles(mejor.ventas)}. Toca una barra para ver el monto.` : 'Aún no hay ventas en estos 30 días.';
}

function barras(selector, filas, color) {
  const caja = $(selector);
  if (!filas.length) {
    caja.replaceChildren(Object.assign(document.createElement('p'), { className: 'vacio', textContent: 'Aún no hay ventas este mes.' }));
    return;
  }
  caja.replaceChildren(...filas.map((f) => {
    const fila = document.createElement('div');
    fila.className = 'fila';
    const linea = document.createElement('div');
    const nombre = document.createElement('span');
    nombre.textContent = f.nombre;
    const monto = document.createElement('span');
    monto.textContent = f.detalle;
    linea.append(nombre, monto);
    const barra = svg('svg', { viewBox: '0 0 100 8', preserveAspectRatio: 'none' });
    barra.append(svg('rect', { x: 0, y: 0, width: 100, height: 8, rx: 4, fill: '#eee' }), svg('rect', { x: 0, y: 0, width: f.ancho, height: 8, rx: 4, fill: color }));
    fila.append(linea, barra);
    return fila;
  }));
}

async function cargarEstadisticas() {
  const e = await api('/estadisticas');
  const chip = (texto) => Object.assign(document.createElement('span'), { className: 'chip', textContent: texto });
  const variacion = document.createElement('span');
  if (e.mes.variacion === null) {
    variacion.textContent = e.mes.comprobantes ? 'El mes anterior no tuvo ventas' : 'Aún sin ventas este mes';
  } else {
    const sube = !e.mes.variacion.startsWith('-');
    variacion.append(chip(`${sube ? '▲' : '▼'} ${e.mes.variacion.replace('-', '')}%`), ' vs. mismos días del mes pasado');
  }
  const tarjetas = [
    kpi('verde', 'Ventas de hoy', soles(e.hoy.ventas), `${e.hoy.comprobantes} comprobante(s)`),
    kpi('morado', 'Ventas del mes', soles(e.mes.ventas), variacion),
    kpi('azul', 'Ticket promedio', soles(e.mes.ticketPromedio), `${e.mes.comprobantes} venta(s) en el mes`),
    kpi('ambar', 'Clientes del mes', String(e.clientes.mes), e.clientes.nuevos ? `+${e.clientes.nuevos} nuevo(s) este mes` : 'con DNI o RUC'),
  ];
  if (e.stockBajo !== undefined) {
    tarjetas.push(kpi(e.stockBajo ? 'rosa' : 'gris', 'Stock bajo', String(e.stockBajo), e.stockBajo ? 'producto(s) por reponer' : 'todo en orden'));
  }
  $('#kpis').replaceChildren(...tarjetas);
  graficoMeses(e.meses);
  graficoDias(e.dias);
  barras('#graf-canales', e.canales.map((c) => ({ nombre: c.canal, detalle: `${soles(c.ventas)} · ${c.porcentaje}%`, ancho: c.porcentaje })), '#2f80ed');
  barras('#graf-productos', e.productos.map((p) => ({ nombre: p.descripcion, detalle: `${miles(p.cantidad)} und · ${soles(p.ventas)}`, ancho: p.alto })), '#d98a10');
  $('#kpis').hidden = false;
  $('#graficos').hidden = false;
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
    const r = await api('/instalacion/activar', { cuerpo: { ...instalacion, codigo: new FormData(e.target).get('codigo') } });
    const correo = instalacion.email;
    instalacion = null;
    $('#vista-instalar').hidden = true;
    mostrarCodigos(r.codigosRespaldo, correo);
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
    const r = await api('/recuperar/activar', { cuerpo: { ...recuperacion, codigo: new FormData(e.target).get('codigo') } });
    const correo = recuperacion.email;
    recuperacion = null;
    $('#form-recuperar').hidden = false;
    $('#form-recuperar').reset();
    $('#form-recuperar-codigo').hidden = true;
    $('#vista-recuperar').hidden = true;
    mostrarCodigos(r.codigosRespaldo, correo);
  } catch (err) {
    $('#error-recuperar-codigo').textContent = err.message;
  }
}

function irARecuperar() {
  $('#vista-entrar').hidden = true;
  $('#vista-recuperar').hidden = false;
  // Por correo solo si el facturador tiene correo configurado; si no, queda la llave de la tienda.
  api('/recuperar').then((r) => {
    $('#form-recuperar-correo').hidden = !r.correo;
    $('#caja-recuperar-llave').open = !r.correo;
  }).catch(() => { $('#caja-recuperar-llave').open = true; });
}

async function alPedirEnlace(e) {
  e.preventDefault();
  try {
    await api('/recuperar/correo', { cuerpo: Object.fromEntries(new FormData(e.target)) });
    mensaje('#mensaje-recuperar-correo', '✔ Si ese correo tiene usuario, te llegó un enlace (revisa también "Spam"). Vale 30 minutos.');
  } catch (err) {
    mensaje('#mensaje-recuperar-correo', err.message, true);
  }
}

// El token del correo llega después de "#": nunca viaja a un servidor ni queda en el historial.
let tokenEnlace = null;
function revisarEnlaceDelCorreo() {
  const m = /^#recuperar=([\w-]{20,100})$/.exec(location.hash);
  if (!m) return false;
  tokenEnlace = m[1];
  history.replaceState(null, '', location.pathname);
  for (const v of ['#vista-entrar', '#vista-panel', '#vista-recuperar', '#vista-instalar']) $(v).hidden = true;
  $('#vista-enlace').hidden = false;
  return true;
}

async function alCambiarConEnlace(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-enlace').textContent = '';
  try {
    const r = await api('/recuperar/correo/cambiar', { cuerpo: { token: tokenEnlace, contrasena: f.get('contrasena'), codigo: f.get('codigo') } });
    tokenEnlace = null;
    e.target.reset();
    alert('✔ Contraseña cambiada. Entra con la nueva.');
    mostrarEntrar();
    $('#form-entrar').email.value = r.email;
  } catch (err) {
    $('#error-enlace').textContent = err.message;
  }
}

function mostrarCodigos(codigos, correo) {
  $('#lista-codigos').replaceChildren(...codigos.map((c) => Object.assign(document.createElement('li'), { textContent: c })));
  $('#vista-codigos').hidden = false;
  $('#codigos-guardados').onclick = () => {
    $('#lista-codigos').replaceChildren();
    if (correo) {
      mostrarEntrar();
      $('#form-entrar').email.value = correo;
    } else {
      $('#vista-codigos').hidden = true;
      $('#vista-panel').hidden = false;
    }
  };
}

async function alGenerarRespaldo(e) {
  e.preventDefault();
  try {
    const r = await api('/codigos-respaldo', { cuerpo: { codigo: new FormData(e.target).get('codigo') } });
    e.target.reset();
    mensaje('#mensaje-respaldo', '');
    $('#vista-panel').hidden = true;
    mostrarCodigos(r.codigosRespaldo);
    $('#estado-respaldo').textContent = `Te quedan ${r.codigosRespaldo.length} códigos sin usar.`;
  } catch (err) {
    mensaje('#mensaje-respaldo', err.message, true);
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
    if (nombre === 'plataforma') await cargarPlataforma();
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

// ---------- Plan del cliente ----------
const ESTADO_PLAN = {
  PRUEBA: 'En prueba', ACTIVA: 'Activo', POR_VENCER: 'Por vencer', EN_GRACIA: 'Vencido (días de gracia)',
  VENCIDA: 'Vencido', SUSPENDIDA: 'Suspendido', CANCELADA: 'Cancelado', PROPIA: 'Propia',
};
function mostrarPlan(plan) {
  // Aviso arriba: lo ve cualquiera que no pueda emitir; el "por vencer", el dueño.
  const aviso = $('#aviso-plan');
  if (plan && !plan.puedeEmitir) {
    aviso.textContent = `⚠️ ${plan.motivo}`;
  } else if (plan?.estado === 'EN_GRACIA') {
    aviso.textContent = `⚠️ Tu plan venció el ${plan.venceEn}. Aún puedes emitir por unos días: renuévalo para no quedarte sin boletas.`;
  } else if (plan?.estado === 'POR_VENCER' || (plan?.estado === 'PRUEBA' && plan.dias <= 3)) {
    aviso.textContent = `Tu ${plan.estado === 'PRUEBA' ? 'prueba' : 'plan'} vence el ${plan.venceEn} (${plan.dias} día(s)).`;
  } else {
    aviso.textContent = '';
  }
  aviso.hidden = !aviso.textContent;
  $('#caja-plan').hidden = !plan?.plan;
  if (!plan?.plan) return;
  $('#detalle-plan').replaceChildren(
    linea('Plan', `${plan.nombrePlan} · S/ ${plan.precioMensual} al mes`),
    linea('Estado', ESTADO_PLAN[plan.estado] || plan.estado),
    linea('Pagado hasta', plan.venceEn),
    linea('Comprobantes este mes', plan.limiteMes ? `${plan.usoMes} de ${plan.limiteMes}` : `${plan.usoMes} (sin límite)`),
    linea('Usuarios', plan.limiteUsuarios ? `${plan.usuarios} de ${plan.limiteUsuarios}` : `${plan.usuarios} (sin límite)`),
  );
}

// ---------- Plataforma (solo su administrador) ----------
function formulario(campos, boton, alEnviar) {
  const f = document.createElement('form');
  for (const [etiqueta, nodo] of campos) {
    const l = document.createElement('label');
    l.append(etiqueta, nodo);
    f.append(l);
  }
  const b = Object.assign(document.createElement('button'), { type: 'submit', className: 'secundario', textContent: boton });
  const m = Object.assign(document.createElement('p'), { role: 'status' });
  f.append(b, m);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      m.textContent = await alEnviar(Object.fromEntries(new FormData(f)));
      m.className = '';
    } catch (err) {
      m.textContent = err.message;
      m.className = 'error';
    }
  });
  return f;
}
const entrada = (name, atributos = {}) => Object.assign(document.createElement('input'), { name, ...atributos });
function selector(name, opciones) {
  const s = document.createElement('select');
  s.name = name;
  for (const [valor, texto] of opciones) s.append(new Option(texto, valor));
  return s;
}

async function cargarPlataforma() {
  const [p, salud] = await Promise.all([api('/plataforma'), api('/plataforma/salud')]);
  const r = p.resumen;
  $('#resumen-plataforma').replaceChildren(
    kpi('verde', 'Clientes activos', String(r.activos), `${r.porVencer} por vencer`),
    kpi('azul', 'En prueba', String(r.prueba), 'prueba de 14 días'),
    kpi(r.vencidos ? 'rosa' : 'gris', 'Vencidos', String(r.vencidos), 'cobrar o suspender'),
    kpi('morado', 'Ingreso mensual', soles(r.ingresoMensual), 'estimado (planes activos)'),
  );
  const opcionesPlan = p.planes.filter((x) => x.activo).map((x) => [x.codigo, `${x.nombre} (S/ ${x.mensual})`]);
  $('#lista-clientes').replaceChildren(...p.clientes.map((c) => {
    const s = c.suscripcion;
    const li = document.createElement('li');
    li.className = 'cliente';
    const d = document.createElement('details');
    const resumen = document.createElement('summary');
    const nombre = document.createElement('strong');
    nombre.textContent = `${c.razonSocial} · ${c.ruc}`;
    const estado = Object.assign(document.createElement('span'), { className: `estado-plan ${s ? s.estado : 'PROPIA'}`, textContent: s ? ESTADO_PLAN[s.estado] : 'Propia' });
    const datos = document.createElement('div');
    datos.className = 'datos';
    const partes = [
      s ? `${s.nombrePlan} · hasta ${s.venceEn} · ${s.usoMes}${s.limiteMes ? `/${s.limiteMes}` : ''} comprobantes este mes` : 'sin plan',
      c.ambiente === 'PRODUCCION' ? 'PRODUCCIÓN' : 'beta',
      c.certificadoVence ? `certificado hasta ${c.certificadoVence}` : '⚠️ sin certificado',
      ...(c.pendientes ? [`${c.pendientes} en cola`] : []),
      ...(c.rechazados7d ? [`⚠️ ${c.rechazados7d} rechazado(s) en 7 días`] : []),
    ];
    datos.textContent = partes.join(' · ');
    resumen.append(nombre, estado, datos);
    d.append(resumen);
    if (c.contacto) d.append(Object.assign(document.createElement('p'), { className: 'nota', textContent: `Contacto: ${c.contacto}` }));
    if (s) {
      d.append(formulario([
        ['Registrar pago ', selector('periodo', [['MENSUAL', 'Mensual'], ['ANUAL', 'Anual']])],
        ['Plan ', selector('plan', opcionesPlan.map(([v, t]) => [v, t]))],
        ['Cómo pagó ', entrada('medio', { placeholder: 'Yape, transferencia…', required: true, maxLength: 60 })],
        ['Monto (vacío = precio del plan) ', entrada('monto', { inputMode: 'decimal', maxLength: 12 })],
        ['N.º de operación ', entrada('referencia', { maxLength: 120 })],
      ], 'Registrar pago', async (v) => {
        const res = await api(`/plataforma/${c.empresaId}/pago`, { cuerpo: v });
        setTimeout(cargarPlataforma, 1200);
        return `✔ Pagado S/ ${res.monto}: activo hasta el ${res.hasta}.`;
      }));
      d.querySelector('[name=plan]').value = s.plan;
      d.append(formulario([
        ['Cambiar a ', selector('estado', [['', '(mismo estado)'], ['ACTIVA', 'Activo'], ['SUSPENDIDA', 'Suspendido'], ['CANCELADA', 'Cancelado']])],
        ['Plan ', selector('plan', [['', '(mismo plan)'], ...opcionesPlan])],
        ['Motivo (queda en el historial) ', entrada('motivo', { required: true, maxLength: 300 })],
      ], 'Guardar cambio', async (v) => {
        await api(`/plataforma/${c.empresaId}/cambio`, { cuerpo: v });
        setTimeout(cargarPlataforma, 1200);
        return '✔ Cambio guardado.';
      }));
    }
    li.append(d);
    return li;
  }));
  $('#lista-planes').replaceChildren(...p.planes.map((x) => {
    const f = formulario([
      ['Mensual S/ ', entrada('mensual', { value: x.mensual, inputMode: 'decimal', required: true })],
      ['Anual S/ ', entrada('anual', { value: x.anual, inputMode: 'decimal', required: true })],
      ['Comprob./mes ', entrada('comprobantesMes', { value: x.comprobantesMes ?? '', inputMode: 'numeric' })],
      ['Usuarios ', entrada('usuariosMax', { value: x.usuariosMax ?? '', inputMode: 'numeric' })],
    ], `Guardar ${x.nombre}`, async (v) => {
      await api(`/plataforma/planes/${x.codigo}`, { cuerpo: v });
      return '✔ Guardado.';
    });
    f.className = 'plan-fila';
    f.prepend(Object.assign(document.createElement('b'), { textContent: x.nombre }));
    return f;
  }));
  $('#numeros-salud').textContent = `${salud.ultimas24h} comprobante(s) en 24 h · ${salud.enCola} en cola · base de datos ${salud.baseDatosMb} MB de ${salud.limiteBaseDatosMb} MB`;
  $('#problemas-salud').replaceChildren(...(salud.problemas.length
    ? salud.problemas.map((x) => linea(`${x.nivel === 'ROJO' ? '🔴' : '🟡'} ${x.mensaje}`, ''))
    : [linea('✔ Todo en orden', '')]));
  $('#errores-salud').replaceChildren(...(salud.errores.length
    ? salud.errores.map((x) => linea(`${x.mensaje}${x.ruta ? ` (${x.ruta})` : ''}`, x.fecha.slice(0, 16).replace('T', ' ')))
    : [linea('Sin errores registrados', '')]));
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
  datos.propia = datos.propia === 'on';
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
  $('#ir-recuperar').addEventListener('click', irARecuperar);
  $('#form-recuperar-correo').addEventListener('submit', alPedirEnlace);
  $('#form-enlace').addEventListener('submit', alCambiarConEnlace);
  $('#form-respaldo').addEventListener('submit', alGenerarRespaldo);
  $('#copiar-codigos').addEventListener('click', () => {
    const texto = [...document.querySelectorAll('#lista-codigos li')].map((li) => li.textContent).join('\n');
    navigator.clipboard?.writeText(texto).then(() => alert('✔ Copiados.')).catch(() => alert('No se pudo copiar: anótalos a mano.'));
  });
  $('#usar-respaldo').addEventListener('click', () => {
    // Los códigos de respaldo llevan letras: se cambia el teclado del celular.
    const campo = $('#form-entrar').codigo;
    campo.inputMode = 'text';
    campo.focus();
    $('#etiqueta-codigo').textContent = 'Código de respaldo (ej. K7QM2-XW9RP)';
    $('#usar-respaldo').hidden = true;
  });
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
  if (!revisarEnlaceDelCorreo()) cargarPanel().catch(mostrarEntrar);
  // El enlace pegado en una pestaña donde el panel ya estaba abierto no recarga la página.
  window.addEventListener('hashchange', revisarEnlaceDelCorreo);
});
