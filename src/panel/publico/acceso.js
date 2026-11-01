// Panel del facturador · Acceso y formularios: primera configuración, recuperar el acceso, emitir, pestañas y plan.
// Secciones: Primera configuración; Recuperar el acceso; Formularios; Pestañas; Plan del cliente.
// Los archivos del panel se cargan en orden (ver index.html) y comparten sus funciones:
// lo de un archivo anterior se puede usar aquí directamente.
'use strict';

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
