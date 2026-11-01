// Panel del facturador · Administrador de la plataforma, reportes, escáner y app instalable.
// Secciones: Plataforma (solo su administrador); Reportes: "algo no funciona" o "me falta esto"; Escáner de códigos de barras; App instalable y versión nueva.
// Los archivos del panel se cargan en orden (ver index.html) y comparten sus funciones:
// lo de un archivo anterior se puede usar aquí directamente.
'use strict';

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
