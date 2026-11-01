// Panel del facturador · Ajustes: usuarios, certificado, empresas, configuración, invitaciones y el arranque del panel.
// Secciones: Usuarios, certificado y empresas; Lista de configuración y usuario SOL; Invitación recibida (#invitacion=…).
// Los archivos del panel se cargan en orden (ver index.html) y comparten sus funciones:
// lo de un archivo anterior se puede usar aquí directamente.
'use strict';

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
    // Comisión del vendedor (% sobre sus ventas sin IGV); se ve estimada en Estadísticas.
    if (u.rol !== 'DUENO' && u.rol !== 'CONTADOR' && u.rol !== 'SOLO_LECTURA') {
      const com = Object.assign(document.createElement('button'), { type: 'button', className: 'enlace', textContent: u.comision ? `Comisión ${Number(u.comision)}%` : 'Poner comisión' });
      com.addEventListener('click', async () => {
        const p = prompt(`Comisión de ${u.nombre} (% sobre sus ventas sin IGV). Déjalo vacío para quitarla:`, u.comision ? String(Number(u.comision)) : '');
        if (p === null) return;
        try { await api(`/usuarios/${u.id}/comision`, { cuerpo: { porcentaje: p.trim() } }); await cargarUsuarios(); } catch (err) { alert(err.message); }
      });
      li.append(com);
    }
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
  const que = $('#que-exportar').value;
  const res = await api(`/exportar?que=${que}&mes=${encodeURIComponent(mes)}`, { crudo: true });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error?.mensaje || 'No se pudo exportar.'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `${que}-${mes}.csv`;
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
