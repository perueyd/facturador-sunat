// Panel del facturador. Sin librerías: es una sola página que habla con /panel/api.
//
// Regla de dinero: los montos viajan como TEXTO ("59.90") y el total que se ve aquí se
// calcula en céntimos enteros (BigInt), nunca con números de JavaScript. El total que
// vale es el del facturador, que se muestra al emitir.
// Archivos (en este orden, ver index.html): app.js, ventas.js, acceso.js, plataforma.js, cobros.js, compras.js, ajustes.js.
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
  // Compras y gastos: solo para quien los ve (dueño, administrador, contador) y si la empresa usa esas funciones.
  for (const o of $('#que-exportar').options) o.hidden = o.value === 'compras' ? !yo.puedeComprar : o.value === 'gastos' ? !yo.verCaja : false;
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
