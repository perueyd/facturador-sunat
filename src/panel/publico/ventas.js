// Panel del facturador · Vender: cotizaciones, inicio del dueño, tablero y estadísticas.
// Secciones: Cotizaciones (proformas); Panel de control (inicio del dueño); Tablero; Estadísticas de ventas.
// Los archivos del panel se cargan en orden (ver index.html) y comparten sus funciones:
// lo de un archivo anterior se puede usar aquí directamente.
'use strict';

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
  // Ventas − compras − gastos del mes: una guía, no el resultado contable (por eso dice "estimado").
  const r = e.resultado;
  const perdida = r.resultado.startsWith('-');
  tarjetas.push(kpi(perdida ? 'rosa' : 'verde', 'Resultado del mes (estimado)', perdida ? `−${soles(r.resultado.slice(1))}` : soles(r.resultado),
    `ventas ${soles(r.ventas)} − compras ${soles(r.compras)} − gastos ${soles(r.gastos)} (sin IGV en ventas y compras)`));
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
