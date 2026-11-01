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
  if (res.status === 401 && ruta !== '/entrar' && !['/instalacion', '/recuperar', '/invitacion'].some((r) => ruta.startsWith(r))) mostrarEntrar();
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
  // Producto guardado: al elegirlo de la lista se pone su precio y su código (así descuenta stock).
  nodo.querySelector('[name=descripcion]').addEventListener('change', (e) => {
    const fila = e.target.closest('.item');
    const p = productos.find((x) => x.nombre === e.target.value);
    fila.querySelector('[name=codigo]').value = p ? p.sku : '';
    if (p) {
      fila.querySelector('[name=precio]').value = p.precio;
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
  $('#vista-invitacion').hidden = true;
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
  if (!yo.puedeEmitir) $('#venta-rapida').hidden = true;
  $('#caja-exportar').hidden = !tiene('exportar');
  for (const b of document.querySelectorAll('#pestanas button')) {
    const modulo = b.dataset.modulo;
    b.dataset.texto ??= b.textContent;
    // Una sección que el plan no trae se ve con candado: al tocarla se ofrece el plan que la incluye.
    const bloqueada = yo.bloqueadas.find((x) => x.seccion === modulo);
    b.dataset.bloqueada = bloqueada ? '1' : '';
    b.textContent = bloqueada ? `🔒 ${b.dataset.texto}` : b.dataset.texto;
    b.hidden = !bloqueada && ((modulo && !tiene(modulo)) || (b.dataset.pestana === 'compras' && !yo.puedeComprar));
  }
  $('#caja-producto').hidden = !yo.puedeAdministrar;
  $('#caja-logo').hidden = !yo.puedeAdministrar;
  $('#caja-usuarios').hidden = !yo.esDueno;
  $('#caja-certificado').hidden = !yo.esDueno;
  $('#caja-sol').hidden = !yo.esDueno;
  $('#caja-empresa-nueva').hidden = !yo.adminPlataforma;
  $('#boton-plataforma').hidden = !yo.adminPlataforma;
  $('#caja-cuentas').hidden = !(yo.puedeAdministrar && tiene('cobros'));
  cargarCuentas().catch(() => {});
  mostrarPlan(yo.plan);
  // Sin códigos de respaldo, perder el celular obliga a usar la llave de la tienda: se avisa.
  $('#estado-respaldo').textContent = yo.codigosRespaldo
    ? `Te quedan ${yo.codigosRespaldo} códigos sin usar.`
    : '⚠️ No tienes códigos de respaldo: genéralos ahora por si pierdes el celular.';
  $('#caja-ajuste').hidden = !yo.puedeAdministrar;
  if (!$('#mes-exportar').value) $('#mes-exportar').value = new Date().toISOString().slice(0, 7);
  productos = tiene('productos') ? (await api('/productos').catch(() => ({ productos: [] }))).productos : [];
  $('#lista-productos').replaceChildren(...productos.map((p) => new Option(`S/ ${p.precio}`, p.nombre)));
  // El dueño y el administrador entran a su panel de control; quien vende, directo a vender.
  $('#boton-inicio').hidden = !yo.puedeAdministrar;
  if (yo.puedeAdministrar) {
    dibujarAccesos();
    await abrirPestana('inicio');
  }
  await Promise.all([cargarTablero(), cargarLista(), cargarVentaRapida().catch(() => undefined), cargarCotizaciones().catch(() => undefined)]);
}

// ---------- Cotizaciones (proformas) ----------
// No son comprobantes: se guardan aparte con su propio número (COT-000001). Para venderla se
// carga en el formulario de Vender y, al emitir la boleta o factura, queda enlazada.
let cotizacionActual = null;

function leerFormularioVenta() {
  const f = new FormData($('#form-emitir'));
  return {
    cliente: { tipoDocumento: f.get('tipoDocumento'), numero: String(f.get('numero')).trim(), nombre: String(f.get('nombre')).trim() },
    items: [...document.querySelectorAll('#items .item')].map((fila) => ({
      codigo: fila.querySelector('[name=codigo]').value,
      descripcion: fila.querySelector('[name=descripcion]').value.trim(),
      cantidad: fila.querySelector('[name=cantidad]').value.trim().replace(',', '.'),
      precio: fila.querySelector('[name=precio]').value.trim().replace(',', '.'),
    })).filter((x) => x.descripcion || x.precio),
  };
}

async function alCotizar() {
  $('#error-emitir').textContent = '';
  const dias = Number($('#dias-cotizacion').value || 7);
  try {
    const k = await api('/cotizaciones', { cuerpo: { ...leerFormularioVenta(), diasValidez: dias, nota: $('#nota-cotizacion').value } });
    $('#nota-cotizacion').value = '';
    await cargarCotizaciones();
    alert(`Cotización ${k.numero} guardada por S/ ${k.total}. Mándala por WhatsApp desde la lista "Cotizaciones".`);
  } catch (err) {
    $('#error-emitir').textContent = err.message;
  }
}

/** Carga una cotización en el formulario para venderla (o null para dejar de usarla). */
function usarCotizacion(k) {
  cotizacionActual = k;
  $('#aviso-cotizacion').hidden = !k;
  if (!k) return;
  $('#aviso-cotizacion').textContent = `Vendiendo la cotización ${k.numero}: revisa los datos, elige cómo pagó y pulsa Emitir.`;
  const f = $('#form-emitir');
  f.tipo.value = k.cliente.tipoDocumento === 'RUC' ? 'FACTURA' : 'BOLETA';
  f.tipoDocumento.value = k.cliente.tipoDocumento;
  f.numero.value = k.cliente.numero;
  f.nombre.value = k.cliente.nombre;
  $('#items').replaceChildren();
  for (const it of k.items) {
    agregarItem();
    const fila = [...document.querySelectorAll('#items .item')].at(-1);
    fila.querySelector('[name=codigo]').value = it.codigo ?? '';
    fila.querySelector('[name=descripcion]').value = it.descripcion;
    fila.querySelector('[name=cantidad]').value = it.cantidad;
    fila.querySelector('[name=precio]').value = it.precio;
  }
  recalcularTotal();
  abrirPestana('vender').then(() => f.scrollIntoView({ behavior: 'smooth' }));
}

const ESTADO_COTIZACION = { VIGENTE: 'vigente', CONVERTIDA: 'vendida', ANULADA: 'anulada' };

async function cargarCotizaciones() {
  if (!yo?.puedeEmitir) return;
  const { cotizaciones } = await api('/cotizaciones');
  const hoy = hoyLima();
  $('#lista-cotizaciones').replaceChildren(...(cotizaciones.length ? cotizaciones.map((k) => {
    const vencida = k.estado === 'VIGENTE' && k.validaHasta < hoy;
    const estado = k.estado === 'CONVERTIDA' ? `vendida (${k.comprobante})` : vencida ? 'vencida' : ESTADO_COTIZACION[k.estado];
    const li = linea(`${k.numero} · ${k.cliente.nombre || 'sin nombre'}`, `${soles(k.total)} · ${estado}`, k.estado === 'ANULADA' ? 'apagado' : '');
    li.addEventListener('click', (e) => {
      if (e.target.closest('.botones')) return;
      const abierto = li.querySelector('.botones');
      if (abierto) { abierto.remove(); return; }
      const botones = document.createElement('div');
      botones.className = 'botones';
      botones.append(boton('PDF', () => abrirArchivo(`/cotizaciones/${k.id}/pdf`)));
      botones.append(boton('Enviar por WhatsApp', () => {
        const texto = `Hola${k.cliente.nombre ? ` ${k.cliente.nombre}` : ''}, te envío la cotización ${k.numero} por S/ ${k.total} (válida hasta el ${fechaPeru(k.validaHasta)}): ${k.enlace}`;
        window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
      }));
      botones.append(boton('Copiar enlace', () => navigator.clipboard?.writeText(k.enlace)));
      if (k.estado === 'VIGENTE') {
        botones.append(boton('Vender (boleta o factura)', () => usarCotizacion(k)));
        const anular = boton('Anular', async () => {
          if (!confirm(`¿Anular la cotización ${k.numero}? Queda guardada como anulada.`)) return;
          try { await api(`/cotizaciones/${k.id}/anular`, { cuerpo: {} }); await cargarCotizaciones(); } catch (err) { alert(err.message); }
        });
        anular.classList.add('peligro');
        botones.append(anular);
      }
      li.append(botones);
    });
    return li;
  }) : [linea('Aún no hay cotizaciones. Llena la venta y pulsa "Guardar como cotización".', '')]));
}

// ---------- Panel de control (inicio del dueño) ----------
// Cada acceso lleva a una pestaña o a una sección de "Más". Solo se muestran los que el rol
// y el plan permiten (si la pestaña o la sección están ocultas, el acceso tampoco sale).
const ACCESOS = [
  ['🏢', 'Panel del administrador', 'Tus clientes, cobros, uso y salud del sistema', 'plataforma'],
  ['🧾', 'Vender', 'Boletas y facturas', 'vender'],
  ['💰', 'Cobros y caja', 'Por cobrar, caja y cierre del día', 'cobrar'],
  ['📦', 'Stock', 'Productos, reposición y Kardex', 'stock'],
  ['🛒', 'Compras', 'Registrar compras a proveedores', 'compras'],
  ['⚙️', 'Configuración', 'Lo que le falta a tu empresa', 'mas', '#caja-configuracion'],
  ['👥', 'Usuarios', 'Invitar vendedores o a tu contador', 'mas', '#caja-usuarios'],
  ['🏦', 'Cuentas de cobro', 'Yape, efectivo, banco…', 'mas', '#caja-cuentas'],
  ['🖼️', 'Logo', 'El que sale en tus boletas', 'mas', '#caja-logo'],
  ['🔐', 'Certificado digital', 'Para firmar los comprobantes', 'mas', '#caja-certificado'],
  ['🔑', 'Usuario SOL', 'Para pasar a producción', 'mas', '#caja-sol'],
  ['📊', 'Para tu contador', 'Ventas del mes en Excel', 'mas', '#caja-exportar'],
  ['➕', 'Empresa nueva', 'Dar de alta a un cliente', 'mas', '#caja-empresa-nueva'],
];

function dibujarAccesos() {
  const visible = (pestana, seccion) => {
    const boton = document.querySelector(`#pestanas button[data-pestana="${pestana}"]`);
    return boton && !boton.hidden && !(seccion && $(seccion).hidden);
  };
  $('#accesos').replaceChildren(...ACCESOS.filter(([, , , pestana, seccion]) => visible(pestana, seccion)).map(([icono, titulo, detalle, pestana, seccion]) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'acceso' });
    b.append(Object.assign(document.createElement('span'), { className: 'icono', textContent: icono }),
      Object.assign(document.createElement('strong'), { textContent: titulo }), Object.assign(document.createElement('small'), { textContent: detalle }));
    b.addEventListener('click', async () => {
      await abrirPestana(pestana);
      if (!seccion) return;
      const destino = $(seccion);
      if (destino.tagName === 'DETAILS') destino.open = true;
      destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return b;
  }));
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
  const estadisticasEnOtroPlan = yo?.bloqueadas?.find((x) => x.seccion === 'estadisticas');
  if (yo?.verEstadisticas) {
    cargarEstadisticas().catch(sinEstadisticas);
  } else if (estadisticasEnOtroPlan && yo.puedeAdministrar) {
    // Se muestra qué tendría con el plan que las trae (con candado).
    sinEstadisticas();
    const k = kpi('gris', '🔒 Estadísticas de ventas', `Plan ${estadisticasEnOtroPlan.plan}`, 'Ventas del mes, gráficos y lo más vendido. Toca para pedirlo.');
    k.addEventListener('click', () => ofrecerPlan('estadisticas'));
    $('#kpis').replaceChildren(k);
    $('#kpis').hidden = false;
  } else {
    sinEstadisticas();
  }
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
  if (t.porPagar) {
    const urgente = t.porPagar.vencido !== '0.00' || t.porPagar.vencePronto !== '0.00';
    tarjetas.push(tarjeta('Por pagar a proveedores', `S/ ${t.porPagar.saldo}`,
      t.porPagar.vencido !== '0.00' ? `⚠️ vencido S/ ${t.porPagar.vencido}` : t.porPagar.vencePronto !== '0.00' ? `vence en 7 días S/ ${t.porPagar.vencePronto}` : 'al día', urgente ? 'urgente' : ''));
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
    kpi('verde', 'Ventas de hoy', soles(e.hoy.ventas), `${e.hoy.comprobantes} comprobante(s)${e.hoy.notasCredito !== '0.00' ? ` · notas de crédito −${soles(e.hoy.notasCredito)}` : ''}`),
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

const abrirPdf = (id, formato) => abrirArchivo(`/comprobantes/${id}/pdf?formato=${formato}`);

/** Abre un PDF del panel (necesita la sesión, por eso se descarga aquí y no con un enlace). */
async function abrirArchivo(ruta) {
  const ventana = window.open('', '_blank');
  const res = await api(ruta, { crudo: true });
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
    ...(fila.querySelector('[name=codigo]').value ? { codigo: fila.querySelector('[name=codigo]').value } : {}),
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
    ...(f.get('medio') ? { pago: { ...leerMedio(f.get('medio')), ...(f.get('referencia') ? { referencia: f.get('referencia') } : {}) } } : {}),
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
    if (cotizacionActual && c.tipo !== '07') {
      await api(`/cotizaciones/${cotizacionActual.id}/convertida`, { cuerpo: { comprobanteId: c.id } }).catch((err) => alert(`El comprobante salió, pero no se pudo enlazar la cotización: ${err.message}`));
      usarCotizacion(null);
      cargarCotizaciones().catch(() => undefined);
    }
    // Listo: el siguiente comprobante es otro pedido.
    pedidoActual = nuevoPedido();
    e.target.reset();
    $('#items').replaceChildren();
    $('#cuotas').replaceChildren();
    $('#caja-cuotas').hidden = true;
    $('#opcion-credito').disabled = true;
    agregarItem();
    recalcularTotal();
    await Promise.all([cargarLista(), cargarTablero(), cargarVentaRapida().catch(() => undefined)]);
  } catch (err) {
    $('#error-emitir').textContent = [err.message, ...(err.detalles || [])].join('\n');
  } finally {
    b.disabled = false;
    b.textContent = 'Emitir';
  }
}

// ---------- Pestañas ----------
const NOMBRE_SECCION = { cobros: 'Cobros y caja', productos: 'Stock e inventario', compras: 'Compras', estadisticas: 'Estadísticas de ventas' };
function ofrecerPlan(seccion) {
  const b = yo.bloqueadas.find((x) => x.seccion === seccion);
  for (const v of document.querySelectorAll('[data-vista]')) v.hidden = v.dataset.vista !== 'mejorar';
  $('#texto-mejorar').textContent = b
    ? `"${NOMBRE_SECCION[seccion]}" viene en el plan ${b.plan} (S/ ${b.precio} al mes).`
    : 'Esta sección no está en tu plan.';
  $('#pedir-plan').onclick = async () => {
    try {
      await api('/reportes', { cuerpo: { tipo: 'SUGERENCIA', mensaje: `Quiero activar "${NOMBRE_SECCION[seccion]}"${b ? ` (plan ${b.plan})` : ''}.`, pantalla: seccion } });
      mensaje('#mensaje-mejorar', '✔ Listo: tu proveedor del facturador te contactará.');
    } catch (err) {
      mensaje('#mensaje-mejorar', err.message, true);
    }
  };
}

async function abrirPestana(nombre) {
  const boton = document.querySelector(`#pestanas button[data-pestana="${nombre}"]`);
  if (boton?.dataset.bloqueada) {
    for (const b of document.querySelectorAll('#pestanas button')) b.classList.toggle('activa', b === boton);
    ofrecerPlan(boton.dataset.modulo);
    return;
  }
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
    kpi('verde', 'Cobrado este mes', soles(p.actividad.cobradoMes), 'pagos registrados'),
  );
  const a = p.actividad;
  $('#actividad-plataforma').replaceChildren(
    kpi('azul', 'Empresas', String(a.empresas), `${a.usuarios} usuario(s) activos`),
    kpi('verde', 'Comprobantes hoy', String(a.comprobantesHoy), `${a.comprobantesMes} este mes`),
    kpi(salud.enCola ? 'ambar' : 'gris', 'En cola para SUNAT', String(salud.enCola), salud.enCola ? 'se reintentan solos' : 'todo enviado'),
    kpi(a.reportesPendientes ? 'rosa' : 'gris', 'Reportes sin atender', String(a.reportesPendientes), 'de tus clientes'),
    kpi(a.errores24h ? 'rosa' : 'gris', 'Errores en 24 h', String(a.errores24h), 'internos del servidor'),
    kpi(salud.baseDatosMb * 100 >= salud.limiteBaseDatosMb * 80 ? 'rosa' : 'gris', 'Base de datos', `${salud.baseDatosMb} MB`, `de ${salud.limiteBaseDatosMb} MB del plan`),
  );
  // Lo urgente arriba, para no tener que bajar a buscarlo.
  const rojos = salud.problemas.filter((x) => x.nivel === 'ROJO').length;
  $('#alerta-plataforma').hidden = !salud.problemas.length;
  $('#alerta-plataforma').textContent = `${rojos ? '🔴' : '🟡'} ${salud.problemas.length} aviso(s) en la salud del sistema: ${salud.problemas[0]?.mensaje ?? ''}`;
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
    // El dueño del negocio recibe su enlace y configura todo él mismo (certificado, usuario SOL…).
    const cajaEnlace = Object.assign(document.createElement('div'), { className: 'enlace-invitacion', hidden: true });
    d.append(formulario([
      ['Invitar al dueño del negocio · correo ', entrada('email', { type: 'email', required: true, maxLength: 200 })],
      ['Nombre ', entrada('nombre', { required: true, maxLength: 120 })],
    ], 'Crear enlace de invitación', async (v) => {
      const r = await api(`/plataforma/${c.empresaId}/invitar`, { cuerpo: v });
      if (r.existente) return '✔ Ya tenía cuenta: ahora es dueño de esta empresa.';
      mostrarEnlace(cajaEnlace, r, v.nombre);
      return '';
    }), cajaEnlace);
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
      // Secciones que trae este plan (las básicas para cumplir con SUNAT van en todos).
      ...Object.entries(NOMBRE_SECCION).map(([sec, texto]) => [`${texto} `, entrada(`seccion-${sec}`, { type: 'checkbox', checked: x.secciones.includes(sec) })]),
    ], `Guardar ${x.nombre}`, async (v) => {
      const secciones = Object.keys(NOMBRE_SECCION).filter((sec) => v[`seccion-${sec}`] === 'on');
      await api(`/plataforma/planes/${x.codigo}`, { cuerpo: { mensual: v.mensual, anual: v.anual, comprobantesMes: v.comprobantesMes, usuariosMax: v.usuariosMax, secciones } });
      return '✔ Guardado.';
    });
    f.className = 'plan-fila';
    f.prepend(Object.assign(document.createElement('b'), { textContent: x.nombre }));
    return f;
  }));
  cargarReportes().catch(() => {});
  $('#numeros-salud').textContent = `${salud.ultimas24h} comprobante(s) en 24 h · ${salud.enCola} en cola · base de datos ${salud.baseDatosMb} MB de ${salud.limiteBaseDatosMb} MB`;
  $('#problemas-salud').replaceChildren(...(salud.problemas.length
    ? salud.problemas.map((x) => linea(`${x.nivel === 'ROJO' ? '🔴' : '🟡'} ${x.mensaje}`, ''))
    : [linea('✔ Todo en orden', '')]));
  $('#errores-salud').replaceChildren(...(salud.errores.length
    ? salud.errores.map((x) => linea(`${x.mensaje}${x.ruta ? ` (${x.ruta})` : ''}`, x.fecha.slice(0, 16).replace('T', ' ')))
    : [linea('Sin errores registrados', '')]));
}

// ---------- Reportes: "algo no funciona" o "me falta esto" ----------
async function alReportar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const pantalla = document.querySelector('#pestanas button.activa')?.dataset.pestana || '';
  try {
    await api('/reportes', { cuerpo: { tipo: f.get('tipo'), mensaje: f.get('mensaje'), pantalla } });
    e.target.reset();
    mensaje('#mensaje-reporte', '✔ Gracias. Lo recibimos y te responderemos.');
  } catch (err) {
    mensaje('#mensaje-reporte', err.message, true);
  }
}

async function cargarReportes() {
  const { reportes } = await api('/plataforma/reportes');
  $('#lista-reportes').replaceChildren(...(reportes.length ? reportes.map((r) => {
    const li = linea(`${r.tipo === 'PROBLEMA' ? '⚠️' : '💡'} ${r.mensaje}`, `${r.empresa || ''} · ${r.usuario} · ${r.fecha.slice(0, 10)}`);
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'enlace', textContent: 'Atendido' });
    b.addEventListener('click', async () => {
      try { await api(`/plataforma/reportes/${r.id}/atendido`, { cuerpo: {} }); await cargarReportes(); } catch (err) { alert(err.message); }
    });
    li.append(b);
    return li;
  }) : [linea('Nada pendiente.', '')]));
}

// ---------- Escáner de códigos de barras ----------
// Un lector USB/Bluetooth "escribe" el código y pulsa Enter: funciona en cualquier navegador.
// Con la cámara se usa BarcodeDetector (Chrome en Android); si no existe, el botón no aparece.
function buscarProducto(codigo) {
  const c = codigo.trim();
  return productos.find((p) => p.codigoBarras === c) || productos.find((p) => p.sku === c.toUpperCase());
}

function agregarPorCodigo(codigo) {
  $('#error-codigo').textContent = '';
  const p = buscarProducto(codigo);
  if (!p) {
    $('#error-codigo').textContent = `No hay un producto con el código "${codigo}". Créalo en Stock (con su código de barras).`;
    return;
  }
  ponerEnVenta({ codigo: p.sku, descripcion: p.nombre, precio: p.precio });
}

/** Agrega un producto a la venta; si ya está (mismo código, o misma descripción y precio), suma uno. */
function ponerEnVenta(p) {
  const filas = [...document.querySelectorAll('#items .item')];
  const valor = (f, n) => f.querySelector(`[name=${n}]`).value.trim();
  const misma = filas.find((f) => (p.codigo ? valor(f, 'codigo') === p.codigo : valor(f, 'descripcion') === p.descripcion && valor(f, 'precio') === p.precio));
  if (misma) {
    const cant = misma.querySelector('[name=cantidad]');
    cant.value = /^\d+$/.test(cant.value.trim()) ? String(Number(cant.value.trim()) + 1) : cant.value;
  } else {
    let fila = filas.find((f) => !valor(f, 'descripcion'));
    if (!fila) { agregarItem(); fila = [...document.querySelectorAll('#items .item')].at(-1); }
    fila.querySelector('[name=codigo]').value = p.codigo ?? '';
    fila.querySelector('[name=descripcion]').value = p.descripcion;
    fila.querySelector('[name=precio]').value = p.precio;
  }
  recalcularTotal();
}

async function cargarVentaRapida() {
  const { productos: rapidos } = await api('/venta-rapida');
  $('#venta-rapida').hidden = !rapidos.length || !yo?.puedeEmitir;
  $('#botones-rapidos').replaceChildren(...rapidos.map((p) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'rapido' });
    b.append(Object.assign(document.createElement('span'), { textContent: p.descripcion }), Object.assign(document.createElement('strong'), { textContent: soles(p.precio) }));
    b.addEventListener('click', () => {
      const f = $('#form-emitir');
      // Venta de mostrador: si no se escribió un documento, va como cliente sin documento
      // (el facturador avisa si el monto pasa el límite y hace falta el DNI).
      if (!f.numero.value.trim() && f.tipo.value === 'BOLETA') f.tipoDocumento.value = 'NINGUNO';
      ponerEnVenta(p);
    });
    return b;
  }));
}

let flujoCamara = null;
async function escanearConCamara(alLeer) {
  const dialogo = $('#escaner');
  $('#error-escaner').textContent = '';
  dialogo.showModal();
  try {
    const detector = new BarcodeDetector();
    flujoCamara = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('#video-escaner');
    video.srcObject = flujoCamara;
    await video.play();
    const buscar = async () => {
      if (!flujoCamara) return;
      const [hallado] = await detector.detect(video).catch(() => []);
      if (hallado?.rawValue) { cerrarEscaner(); alLeer(hallado.rawValue); return; }
      setTimeout(buscar, 250);
    };
    buscar();
  } catch {
    $('#error-escaner').textContent = 'No se pudo abrir la cámara. Revisa el permiso de cámara del navegador.';
  }
}
function cerrarEscaner() {
  for (const t of flujoCamara?.getTracks() ?? []) t.stop();
  flujoCamara = null;
  $('#video-escaner').srcObject = null;
  if ($('#escaner').open) $('#escaner').close();
}

// ---------- App instalable y versión nueva ----------
let pedidoInstalar = null;
function prepararApp() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    pedidoInstalar = e;
    $('#instalar-app').hidden = false;
  });
  $('#instalar-app').addEventListener('click', async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    await pedidoInstalar.userChoice.catch(() => {});
    pedidoInstalar = null;
    $('#instalar-app').hidden = true;
  });
  if (!('serviceWorker' in navigator)) return;
  let recargando = false;
  // Cuando una versión NUEVA toma el control, se recarga una sola vez. La primera instalación
  // también "toma el control", pero ahí no hay nada que recargar (cortaría lo que se está escribiendo).
  const habiaVersion = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (habiaVersion && !recargando) { recargando = true; location.reload(); }
  });
  navigator.serviceWorker.register('/panel/sw.js', { scope: '/panel' }).then((reg) => {
    const avisar = (sw) => {
      if (!sw || !navigator.serviceWorker.controller) return;
      $('#aviso-version').hidden = false;
      $('#actualizar-app').onclick = () => sw.postMessage('actualizar');
    };
    avisar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nuevo = reg.installing;
      nuevo?.addEventListener('statechange', () => { if (nuevo.state === 'installed') avisar(nuevo); });
    });
    // Revisa si hay versión nueva cada vez que se vuelve a la app.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

// ---------- Cobrar ----------
let cobroActual = null;
// ---------- Cuentas donde entra el dinero ----------
const MEDIO_TEXTO = { YAPE: 'Yape', PLIN: 'Plin', EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', TARJETA: 'Tarjeta', PASARELA: 'Pasarela', OTRO: 'Otro' };
let cuentas = [];
/**
 * Llena un selector de "dónde entró el dinero": primero las cuentas activas, luego los medios
 * que no tienen cuenta. El valor es "MEDIO|idCuenta" (o "MEDIO|" sin cuenta).
 */
function llenarMedios(select, opcionInicial) {
  const actual = select.value;
  const activas = cuentas.filter((c) => c.activa);
  const conCuenta = new Set(activas.map((c) => c.medio));
  select.replaceChildren(
    ...(opcionInicial ? [new Option(opcionInicial, '')] : []),
    ...activas.map((c) => new Option(`${c.nombre} (${MEDIO_TEXTO[c.medio]})`, `${c.medio}|${c.id}`)),
    ...['EFECTIVO', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'TARJETA'].filter((m) => !conCuenta.has(m)).map((m) => new Option(MEDIO_TEXTO[m], `${m}|`)),
  );
  if ([...select.options].some((o) => o.value === actual)) select.value = actual;
}
const leerMedio = (valor) => {
  const [medio, cuenta] = String(valor || '').split('|');
  return { medio, ...(cuenta ? { cuenta } : {}) };
};

async function cargarCuentas() {
  if (!tiene('cobros')) return;
  cuentas = (await api('/cuentas')).cuentas;
  llenarMedios($('#form-emitir').medio, 'Aún no pagó');
  llenarMedios($('#form-cobro').medio);
  llenarMedios($('#form-gasto').medio);
  if (!yo?.puedeAdministrar) return;
  $('#lista-cuentas').replaceChildren(...(cuentas.length ? cuentas.map((c) => {
    const li = linea(`${c.nombre}${c.titular ? ` · ${c.titular}` : ''}`,
      `${MEDIO_TEXTO[c.medio]}${c.deLaEmpresa ? '' : ' · de otra persona'}${c.predeterminada ? ' · predeterminada' : ''}${c.activa ? '' : ' · desactivada'}`);
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'enlace', textContent: c.activa ? 'Desactivar' : 'Activar' });
    b.addEventListener('click', async () => {
      try {
        await api(`/cuentas/${c.id}`, { cuerpo: { ...c, activa: !c.activa } });
        await cargarCuentas();
      } catch (err) { alert(err.message); }
    });
    li.append(b);
    return li;
  }) : [linea('Aún no tienes cuentas: agrega la primera.', '')]));
}

async function alGuardarCuenta(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/cuentas', { cuerpo: {
      nombre: f.get('nombre'), medio: f.get('medio'), titular: f.get('titular'),
      deLaEmpresa: f.get('deLaEmpresa') === 'on', predeterminada: f.get('predeterminada') === 'on',
    } });
    e.target.reset();
    e.target.deLaEmpresa.checked = true;
    mensaje('#mensaje-cuenta', '✔ Cuenta agregada.');
    await cargarCuentas();
  } catch (err) {
    mensaje('#mensaje-cuenta', err.message, true);
  }
}

// ---------- Caja ----------
function rangoCaja(periodo) {
  // Fechas de Lima (el servidor también calcula en hora de Lima).
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
  const restar = (dias) => new Date(Date.parse(`${hoy}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
  if (periodo === 'semana') return { desde: restar(6), hasta: hoy };
  if (periodo === 'mes') return { desde: `${hoy.slice(0, 7)}-01`, hasta: hoy };
  return { desde: hoy, hasta: hoy };
}

let periodoCaja = 'hoy';
async function cargarCaja(periodo = 'hoy') {
  periodoCaja = periodo;
  for (const b of document.querySelectorAll('#periodo-caja button')) b.classList.toggle('activa', b.dataset.periodo === periodo);
  const { desde, hasta } = rangoCaja(periodo);
  const c = await api(`/caja?desde=${desde}&hasta=${hasta}`);
  $('#kpis-caja').replaceChildren(
    kpi('verde', 'Total cobrado', soles(c.totales.total), `${c.totales.cobros} cobro(s)`),
    kpi(c.totales.gastos !== '0.00' ? 'rosa' : 'gris', 'Gastos', soles(c.totales.gastos), `queda ${soles(c.totales.neto)}`),
    kpi('azul', 'Cuentas de la empresa', soles(c.totales.empresa), 'lo que entró a la empresa'),
    kpi(c.totales.terceros !== '0.00' ? 'ambar' : 'gris', 'Cuentas de otras personas', soles(c.totales.terceros), 'por rendir a la empresa'),
    kpi('morado', 'Vendido', soles(c.vendido), 'boletas y facturas del período'),
  );
  $('#lista-caja').replaceChildren(...(c.cuentas.length
    ? c.cuentas.map((x) => linea(`${x.nombre}${x.titular ? ` · ${x.titular}` : ''}${x.deLaEmpresa ? '' : ' (otra persona)'}`,
      x.gastos === '0.00' ? `${soles(x.monto)} · ${x.cobros} cobro(s)` : `entró ${soles(x.monto)} · salió ${soles(x.gastos)} · queda ${soles(x.neto)}`))
    : [linea('Sin cobros en este período.', '')]));
  $('#nota-caja').hidden = c.totales.terceros === '0.00';
  await cargarGastos(desde, hasta);
}

// ---------- Gastos ----------
async function cargarGastos(desde, hasta) {
  const g = await api(`/gastos?desde=${desde}&hasta=${hasta}`);
  $('#total-gastos').textContent = g.total === '0.00' ? '' : `· ${soles(g.total)}`;
  if (g.porCategoria.length) barras('#gastos-categorias', g.porCategoria.map((x) => ({ nombre: x.nombre, detalle: soles(x.monto), ancho: x.ancho })), '#e0457b');
  else $('#gastos-categorias').replaceChildren();
  $('#lista-gastos').replaceChildren(...(g.gastos.length ? g.gastos.map((x) => {
    const li = linea(`${fechaPeru(x.fecha)} · ${x.descripcion} · ${x.cuenta ?? MEDIO_TEXTO[x.medio] ?? x.medio}${x.documento ? ` · ${x.documento}` : ''} · ${x.registradoPor}`,
      x.anulado ? `anulado: ${x.anulado.motivo}` : soles(x.monto), x.anulado ? 'apagado' : '');
    if (!x.anulado && yo?.puedeAdministrar) {
      li.addEventListener('click', async () => {
        const motivo = prompt(`¿Anular el gasto "${x.descripcion}" de ${soles(x.monto)}? Escribe el motivo:`);
        if (!motivo) return;
        try { await api(`/gastos/${x.id}/anular`, { cuerpo: { motivo } }); await cargarCaja(periodoCaja); } catch (err) { alert(err.message); }
      });
    }
    return li;
  }) : [linea('Sin gastos en este período.', '')]));
}

async function alRegistrarGasto(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/gastos', { cuerpo: {
      ...leerMedio(f.get('medio')), monto: String(f.get('monto')).trim().replace(',', '.'), categoria: f.get('categoria'),
      descripcion: f.get('descripcion'), fecha: f.get('fecha') || hoyLima(), documento: f.get('documento'),
    } });
    e.target.reset();
    mensaje('#mensaje-gasto', '✔ Gasto registrado.');
    if (yo?.verCaja) await cargarCaja(periodoCaja);
  } catch (err) {
    mensaje('#mensaje-gasto', err.message, true);
  }
}

// ---------- Cierre de caja ----------
// Lo esperado viene del facturador; aquí solo se escribe lo contado y se muestra la diferencia
// en céntimos exactos (BigInt), sin decimales de JavaScript.
const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const conSigno = (c) => (c < 0n ? `− ${textoSoles(-c)}` : c > 0n ? `+ ${textoSoles(c)}` : textoSoles(0n));
const textoDiferencia = (d) => (d.startsWith('-') ? `falta ${soles(d.slice(1))}` : d === '0.00' ? 'cuadra ✔' : `sobra ${soles(d)}`);
let lineasCierre = [];

// Montos del servidor que pueden ser negativos (un día con más gastos que cobros).
const centimosConSigno = (t) => (t.startsWith('-') ? -aCentimos(t.slice(1)) : aCentimos(t));
/** Monto en céntimos con signo solo si es negativo ("S/ 30.00", "− S/ 20.00"). */
const sinMas = (c) => conSigno(c).replace('+ ', '');
const valorDe = (l, campo) => document.querySelector(`#cierre-lineas input[data-clave="${CSS.escape(l.clave)}"][data-campo="${campo}"]`);

function recalcularCierre() {
  let deberia = 0n;
  let contado = 0n;
  let completo = true;
  for (const l of lineasCierre) {
    const fondo = aCentimos(valorDe(l, 'fondo').value) ?? 0n;
    const e = fondo + centimosConSigno(l.esperado);
    const k = aCentimos(valorDe(l, 'contado').value);
    const salida = valorDe(l, 'contado').closest('.linea-cierre').querySelector('.dif');
    deberia += e;
    const debe = `debería haber ${sinMas(e)}`;
    if (k === null) { completo = false; salida.textContent = debe; salida.className = 'dif'; continue; }
    contado += k;
    salida.textContent = k === e ? `${debe} · cuadra ✔` : `${debe} · diferencia ${conSigno(k - e)}`;
    salida.className = `dif ${k === e ? 'ok' : 'mal'}`;
  }
  $('#cierre-total').textContent = completo
    ? `Debería haber ${sinMas(deberia)} · contado ${textoSoles(contado)} · diferencia ${conSigno(contado - deberia)}`
    : `Debería haber ${sinMas(deberia)}. Escribe lo contado en cada cuenta (0 si no hay nada).`;
}

async function cargarCierre(fecha = $('#cierre-fecha').value || hoyLima()) {
  const r = await api(`/caja/cierre?fecha=${fecha}`);
  $('#cierre-fecha').value = r.fecha;
  $('#cierre-fecha').max = hoyLima();
  lineasCierre = r.lineas;
  $('#cierre-lineas').replaceChildren(...r.lineas.map((l) => {
    const caja = Object.assign(document.createElement('div'), { className: 'linea-cierre' });
    const titulo = Object.assign(document.createElement('strong'), { textContent: l.nombre });
    const mov = Object.assign(document.createElement('small'), { textContent: ` · movimiento del día ${l.esperado.startsWith('-') ? `−${soles(l.esperado.slice(1))}` : `+${soles(l.esperado)}`}` });
    const campo = (texto, nombre, valor, ayuda) => {
      const label = Object.assign(document.createElement('label'), { textContent: texto });
      const input = Object.assign(document.createElement('input'), { value: valor, placeholder: ayuda, required: nombre === 'contado' });
      input.dataset.clave = l.clave;
      input.dataset.campo = nombre;
      input.setAttribute('inputmode', 'decimal');
      input.addEventListener('input', recalcularCierre);
      label.append(input);
      return label;
    };
    const fila = Object.assign(document.createElement('div'), { className: 'fila' });
    fila.append(campo('Empezó con', 'fondo', l.fondoSugerido, '0.00'), campo('Contaste', 'contado', '', 'lo que hay ahora'));
    caja.append(titulo, mov, fila, Object.assign(document.createElement('small'), { className: 'dif' }));
    return caja;
  }));
  $('#form-cierre').hidden = !r.lineas.length;
  const ultimo = r.cierres[0];
  $('#cierre-estado').textContent = !r.lineas.length
    ? 'Ese día no hubo cobros y no tienes cuentas creadas.'
    : ultimo
      ? `Ya cerrada por ${ultimo.cerradoPor} a las ${new Date(ultimo.cerradoEn).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })}: ${textoDiferencia(ultimo.totales.diferencia)}. Si contaste mal, ciérrala otra vez (vale la última).`
      : 'Aún no se cierra este día.';
  $('#lista-cierres').replaceChildren(...(r.historial.length
    ? r.historial.map((x) => linea(`${x.fecha} · ${x.cerradoPor}${x.nota ? ` · ${x.nota}` : ''}`, textoDiferencia(x.totales.diferencia), x.totales.diferencia === '0.00' ? '' : 'bajo'))
    : [linea('Todavía no hay cierres.', '')]));
  mensaje('#mensaje-cierre', '');
  recalcularCierre();
}

async function alCerrarCaja(e) {
  e.preventDefault();
  const contados = {};
  const fondos = {};
  for (const input of document.querySelectorAll('#cierre-lineas input')) {
    (input.dataset.campo === 'fondo' ? fondos : contados)[input.dataset.clave] = input.value.trim().replace(',', '.') || (input.dataset.campo === 'fondo' ? '0' : '');
  }
  try {
    const c = await api('/caja/cierre', { cuerpo: { fecha: $('#cierre-fecha').value, contados, fondos, nota: e.target.nota.value } });
    e.target.nota.value = '';
    await cargarCierre(c.fecha);
    mensaje('#mensaje-cierre', `Caja cerrada: ${textoDiferencia(c.totales.diferencia)}.`);
  } catch (err) {
    mensaje('#mensaje-cierre', err.message, true);
  }
}

async function cargarPorCobrar() {
  $('#caja-dinero').hidden = !yo?.verCaja;
  if (yo?.verCaja) cargarCaja().catch(() => { $('#caja-dinero').hidden = true; });
  if (yo?.verCaja) cargarCierre(hoyLima()).catch(() => { $('#caja-cierre').hidden = true; });
  $('#caja-registrar-gasto').hidden = !yo?.puedeEmitir;
  cargarFrecuentes().catch(() => undefined);
  const { porCobrar } = await api('/por-cobrar');
  $('#lista-cobrar').replaceChildren(...(porCobrar.length ? porCobrar.map((x) => {
    const li = linea(`${x.numero} · ${x.cliente}`, `S/ ${x.saldo}${x.proximaCuota ? ` · cuota ${x.proximaCuota}` : ''}`);
    li.addEventListener('click', () => abrirCobro(x));
    return li;
  }) : [linea('Nadie te debe. 🎉', '')]));
  $('#form-cobro').hidden = true;
}

// ---------- WhatsApp con el mensaje listo ----------
// Solo arma el enlace wa.me: el mensaje se abre en WhatsApp del celular y la persona decide si lo envía.
const enlaceWhatsApp = (celular, texto) => `https://wa.me/${celular}?text=${encodeURIComponent(texto)}`;
// Sin el punto final ("S.A.C.") para que la frase no quede con dos puntos seguidos.
const nombreEmpresa = () => (yo?.empresa?.razonSocial ?? '').replace(/\.+$/, '');
const fechaPeru = (iso) => iso.split('-').reverse().join('/');

/**
 * Botón de WhatsApp para un cliente; si aún no tiene celular, un campo para guardarlo.
 * `mensajes` es una lista de [texto del botón, mensaje].
 */
function bloqueWhatsApp(cliente, mensajes, alGuardar) {
  const caja = document.createElement('div');
  caja.className = 'whatsapp';
  const pedirCelular = () => {
    const input = Object.assign(document.createElement('input'), { type: 'tel', placeholder: 'Celular, ej. 987 654 321', value: cliente.celular ? `+${cliente.celular}` : '' });
    const boton = Object.assign(document.createElement('button'), { type: 'button', className: 'secundario', textContent: 'Guardar celular' });
    const error = Object.assign(document.createElement('p'), { className: 'error' });
    boton.addEventListener('click', async () => {
      try {
        const r = await api('/clientes/celular', { cuerpo: { ...cliente.documento, celular: input.value } });
        cliente.celular = r.celular;
        dibujar();
        alGuardar?.();
      } catch (err) {
        error.textContent = err.message;
      }
    });
    caja.replaceChildren(Object.assign(document.createElement('label'), { textContent: `Celular de ${cliente.nombre}` }), input, boton, error);
    input.focus();
  };
  const dibujar = () => {
    if (!cliente.celular) {
      const agregar = Object.assign(document.createElement('button'), { type: 'button', className: 'secundario', textContent: '💬 Agregar celular para WhatsApp' });
      agregar.addEventListener('click', pedirCelular);
      caja.replaceChildren(agregar);
      return;
    }
    const cambiar = Object.assign(document.createElement('button'), { type: 'button', className: 'enlace', textContent: `+${cliente.celular} · cambiar` });
    cambiar.addEventListener('click', pedirCelular);
    caja.replaceChildren(...mensajes.map(([titulo, texto]) => Object.assign(document.createElement('a'), {
      className: 'boton-whatsapp', href: enlaceWhatsApp(cliente.celular, texto), target: '_blank', rel: 'noopener', textContent: `💬 ${titulo}`,
    })), cambiar);
  };
  if (!cliente.documento?.numero || cliente.documento.numero === '-') {
    caja.replaceChildren(Object.assign(document.createElement('small'), { textContent: 'Venta sin DNI ni RUC: no se puede guardar su celular.' }));
  } else dibujar();
  return caja;
}

const mensajeCobro = (nombre, saldo, detalle) =>
  `Hola ${nombre}, te saluda ${nombreEmpresa()}. Te recordamos que tienes un saldo pendiente de S/ ${saldo}${detalle ? ` (${detalle})` : ''}. ` +
  'Si ya lo pagaste, avísanos para registrarlo. ¡Gracias!';

async function cargarFrecuentes() {
  const { clientes } = await api('/clientes/frecuentes');
  $('#lista-frecuentes').replaceChildren(...(clientes.length ? clientes.map((x) => {
    const cliente = { nombre: x.nombre, celular: x.celular, documento: { tipoDocumento: x.tipoDocumento, numero: x.numero } };
    const hace = x.diasSinComprar === 0 ? 'hoy' : x.diasSinComprar === 1 ? 'ayer' : `hace ${x.diasSinComprar} días`;
    const li = linea(`${x.nombre}${x.celular ? ' 💬' : ''} · ${x.compras} compra(s) · última ${hace}`,
      x.saldoPendiente !== '0.00' ? `debe ${soles(x.saldoPendiente)}` : soles(x.totalComprado), x.saldoPendiente !== '0.00' ? 'bajo' : '');
    li.addEventListener('click', (e) => {
      if (e.target.closest('.whatsapp')) return;
      const abierto = li.querySelector('.whatsapp');
      if (abierto) { abierto.remove(); return; }
      const mensajes = [
        ...(x.saldoPendiente !== '0.00' ? [['Recordar cobro', mensajeCobro(x.nombre, x.saldoPendiente)]] : []),
        ['Saludar', `Hola ${x.nombre}, te saluda ${nombreEmpresa()}. ¡Gracias por tu preferencia! Si necesitas algo, escríbenos por aquí.`],
      ];
      li.append(bloqueWhatsApp(cliente, mensajes, () => cargarFrecuentes().catch(() => undefined)));
    });
    return li;
  }) : [linea('Aún no hay clientes con DNI o RUC en tus ventas.', '')]));
}

async function abrirCobro(x) {
  cobroActual = x;
  if ($('[data-vista=cobrar]').hidden) await abrirPestana('cobrar');
  $('#cobro-titulo').textContent = `${x.numero} — saldo S/ ${x.saldo}`;
  const cliente = { nombre: x.cliente, celular: x.celular, documento: x.documento };
  $('#cobro-whatsapp').replaceChildren(bloqueWhatsApp(cliente, [['Recordar cobro por WhatsApp', mensajeCobro(x.cliente, x.saldo, `${x.numero} del ${fechaPeru(x.fecha)}`)]],
    () => { x.celular = cliente.celular; }));
  $('#form-cobro').hidden = false;
  $('#form-cobro').scrollIntoView({ behavior: 'smooth' });
}

async function alCobrar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-cobro').textContent = '';
  try {
    const c = await api(`/comprobantes/${cobroActual.id}/pagos`, { cuerpo: {
      ...leerMedio(f.get('medio')), ...(f.get('monto') ? { monto: String(f.get('monto')).trim().replace(',', '.') } : {}),
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
/** Caja con el enlace de invitación: copiarlo o mandarlo por WhatsApp. */
function mostrarEnlace(caja, r, nombre) {
  caja.replaceChildren();
  const texto = `Hola ${nombre}, te invito al facturador. Abre este enlace para crear tu contraseña (vale 72 horas): ${r.enlace}`;
  const titulo = Object.assign(document.createElement('strong'), { textContent: `✔ Invitación lista${r.porCorreo ? ' (también se envió por correo)' : ''}` });
  const enlace = Object.assign(document.createElement('code'), { textContent: r.enlace });
  const copiar = Object.assign(document.createElement('button'), { type: 'button', className: 'secundario', textContent: 'Copiar enlace' });
  copiar.addEventListener('click', () => navigator.clipboard?.writeText(r.enlace).then(() => { copiar.textContent = '✔ Copiado'; }).catch(() => {}));
  const wa = Object.assign(document.createElement('a'), { className: 'boton-enlace', textContent: '💬 Enviar por WhatsApp', target: '_blank', rel: 'noopener',
    href: `https://wa.me/?text=${encodeURIComponent(texto)}` });
  const nota = Object.assign(document.createElement('p'), { className: 'nota', textContent: 'Vale 72 horas y una sola vez. Si se vence, genera otro desde la lista.' });
  caja.append(titulo, enlace, copiar, wa, nota);
  caja.hidden = false;
}

async function cargarUsuarios() {
  if (yo?.puedeAdministrar) cargarConfiguracion().catch(() => { $('#caja-configuracion').hidden = true; });
  if (!yo?.esDueno) return;
  const { usuarios } = await api('/usuarios');
  $('#lista-usuarios').replaceChildren(...usuarios.map((u) => {
    const li = linea(`${u.nombre} · ${u.email}`, `${u.rol}${u.activo ? '' : ' · desactivado'}${u.pendiente ? ' · invitación pendiente' : ''}`);
    if (u.pendiente && u.activo) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'enlace', textContent: 'Nuevo enlace' });
      b.addEventListener('click', async () => {
        try { mostrarEnlace($('#caja-enlace'), await api(`/usuarios/${u.id}/enlace`, { cuerpo: {} }), u.nombre); } catch (err) { alert(err.message); }
      });
      li.append(b);
    }
    return li;
  }));
}

async function alDarAcceso(e) {
  e.preventDefault();
  const datos = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api('/usuarios', { cuerpo: datos });
    e.target.reset();
    if (r.existente) {
      $('#caja-enlace').hidden = true;
      mensaje('#mensaje-usuario', '✔ Ya tenía cuenta: ahora también tiene acceso a esta empresa.');
    } else {
      mensaje('#mensaje-usuario', '');
      mostrarEnlace($('#caja-enlace'), r, datos.nombre);
    }
    await cargarUsuarios();
  } catch (err) {
    mensaje('#mensaje-usuario', err.message, true);
  }
}

// ---------- Lista de configuración y usuario SOL ----------
async function cargarConfiguracion() {
  const { pasos } = await api('/configuracion');
  const hechos = pasos.filter((p) => p.listo).length;
  $('#avance-configuracion').textContent = `(${hechos} de ${pasos.length})`;
  $('#pasos-configuracion').replaceChildren(...pasos.map((p) => {
    const li = document.createElement('li');
    li.className = p.listo ? 'listo' : '';
    li.append(`${p.listo ? '✔' : '○'} ${p.titulo}`);
    if (!p.listo) li.append(Object.assign(document.createElement('small'), { textContent: p.ayuda }));
    return li;
  }));
  // Con todo listo, la lista ya no estorba.
  $('#caja-configuracion').hidden = hechos === pasos.length;
}

async function alGuardarSol(e) {
  e.preventDefault();
  try {
    await api('/sol', { cuerpo: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    mensaje('#mensaje-sol', '✔ Usuario SOL guardado (cifrado). Solo se usa en producción.');
    await cargarConfiguracion();
  } catch (err) {
    mensaje('#mensaje-sol', err.message, true);
  }
}

// ---------- Invitación recibida (#invitacion=…) ----------
let tokenInvitacion = null;
const ROLES_TEXTO = { DUENO: 'dueño', ADMIN: 'administrador', VENDEDOR: 'vendedor', CONTADOR: 'contador', SOLO_LECTURA: 'consulta' };
function revisarInvitacion() {
  const m = /^#invitacion=([\w-]{20,100})$/.exec(location.hash);
  if (!m) return false;
  tokenInvitacion = m[1];
  history.replaceState(null, '', location.pathname);
  for (const v of ['#vista-entrar', '#vista-panel', '#vista-recuperar', '#vista-instalar', '#vista-enlace']) $(v).hidden = true;
  $('#vista-invitacion').hidden = false;
  api(`/invitacion?token=${encodeURIComponent(tokenInvitacion)}`).then((v) => {
    $('#saludo-invitacion').textContent = `Hola ${v.nombre}: te invitaron a ${v.empresa} como ${ROLES_TEXTO[v.rol] || v.rol}.`;
    $('#form-invitacion').email.value = v.email;
  }).catch((err) => {
    $('#saludo-invitacion').textContent = err.message;
    $('#form-invitacion').hidden = true;
  });
  return true;
}

async function alAceptarInvitacion(e) {
  e.preventDefault();
  $('#error-invitacion').textContent = '';
  try {
    const r = await api('/invitacion', { cuerpo: { token: tokenInvitacion, contrasena: new FormData(e.target).get('contrasena') } });
    $('#qr-invitacion').src = r.qr;
    $('#clave-invitacion').textContent = r.clave;
    $('#abrir-app-invitacion').href = r.url;
    e.target.hidden = true;
    $('#form-invitacion-codigo').hidden = false;
  } catch (err) {
    $('#error-invitacion').textContent = err.message;
  }
}

async function alActivarInvitacion(e) {
  e.preventDefault();
  $('#error-invitacion-codigo').textContent = '';
  try {
    const r = await api('/invitacion/activar', { cuerpo: { token: tokenInvitacion, codigo: new FormData(e.target).get('codigo') } });
    tokenInvitacion = null;
    $('#vista-invitacion').hidden = true;
    mostrarCodigos(r.codigosRespaldo, r.email);
  } catch (err) {
    $('#error-invitacion-codigo').textContent = err.message;
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
  prepararApp();
  const conCamara = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
  $('#escanear-venta').hidden = !conCamara;
  $('#escanear-producto').hidden = !conCamara;
  $('#escanear-venta').addEventListener('click', () => escanearConCamara(agregarPorCodigo));
  $('#escanear-producto').addEventListener('click', () => escanearConCamara((c) => { $('#form-producto').codigoBarras.value = c; }));
  $('#cerrar-escaner').addEventListener('click', cerrarEscaner);
  $('#escaner').addEventListener('close', cerrarEscaner);
  $('#codigo-venta').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Enter del lector: agrega el producto y no envía el formulario.
    e.preventDefault();
    if (e.target.value.trim()) agregarPorCodigo(e.target.value);
    e.target.value = '';
  });
  $('#form-reporte').addEventListener('submit', alReportar);
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
  $('#form-sol').addEventListener('submit', alGuardarSol);
  $('#form-cuenta').addEventListener('submit', alGuardarCuenta);
  for (const b of document.querySelectorAll('#periodo-caja button')) b.addEventListener('click', () => cargarCaja(b.dataset.periodo).catch((err) => alert(err.message)));
  $('#form-cierre').addEventListener('submit', alCerrarCaja);
  $('#condicion-compra').addEventListener('change', (e) => { $('#caja-vence-compra').hidden = e.target.value !== 'CREDITO'; $('#form-compra').vence.required = e.target.value === 'CREDITO'; });
  $('#admin-alta').addEventListener('click', async () => { await abrirPestana('mas'); $('#caja-empresa-nueva').open = true; $('#caja-empresa-nueva').scrollIntoView({ behavior: 'smooth' }); });
  $('#admin-reportes').addEventListener('click', () => $('#titulo-reportes').scrollIntoView({ behavior: 'smooth' }));
  $('#admin-salud').addEventListener('click', () => $('#titulo-salud').scrollIntoView({ behavior: 'smooth' }));
  $('#alerta-plataforma').addEventListener('click', () => $('#titulo-salud').scrollIntoView({ behavior: 'smooth' }));
  $('#form-gasto').addEventListener('submit', alRegistrarGasto);
  $('#boton-cotizar').addEventListener('click', alCotizar);
  $('#cierre-fecha').addEventListener('change', (e) => cargarCierre(e.target.value).catch((err) => mensaje('#mensaje-cierre', err.message, true)));
  $('#form-invitacion').addEventListener('submit', alAceptarInvitacion);
  $('#form-invitacion-codigo').addEventListener('submit', alActivarInvitacion);
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
  if (!revisarEnlaceDelCorreo() && !revisarInvitacion()) cargarPanel().catch(mostrarEntrar);
  // El enlace pegado en una pestaña donde el panel ya estaba abierto no recarga la página.
  window.addEventListener('hashchange', () => revisarEnlaceDelCorreo() || revisarInvitacion());
});
