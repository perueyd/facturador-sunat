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
  if (res.status === 401 && ruta !== '/entrar') mostrarEntrar();
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
  $('#items').appendChild(nodo);
}

// ---------- Vistas ----------
function mostrarEntrar() {
  $('#vista-entrar').hidden = false;
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

async function cargarPanel() {
  const yo = await api('/yo');
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
  await cargarLista();
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
  partes.push(botones);
  caja.replaceChildren(...partes);
  caja.hidden = false;
  caja.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Formularios ----------
async function alEntrar(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#error-entrar').textContent = '';
  try {
    await api('/entrar', { cuerpo: { email: f.get('email'), contrasena: f.get('contrasena'), codigo: f.get('codigo') } });
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
    agregarItem();
    recalcularTotal();
    await cargarLista();
  } catch (err) {
    $('#error-emitir').textContent = [err.message, ...(err.detalles || [])].join('\n');
  } finally {
    b.disabled = false;
    b.textContent = 'Emitir';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#form-entrar').addEventListener('submit', alEntrar);
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
