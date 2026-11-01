// Panel del facturador · Cobrar: cuentas, caja, gastos, cierre de caja, clientes frecuentes y WhatsApp.
// Secciones: Cobrar; Cuentas donde entra el dinero; Caja; Gastos; Cierre de caja; WhatsApp con el mensaje listo.
// Los archivos del panel se cargan en orden (ver index.html) y comparten sus funciones:
// lo de un archivo anterior se puede usar aquí directamente.
'use strict';

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
    if (x.foto) {
      li.append(boton('📎 Ver recibo', (e) => { e.stopPropagation(); abrirArchivo(`/gastos/${x.id}/foto`); }));
    }
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
  const foto = f.get('foto');
  try {
    const { id } = await api('/gastos', { cuerpo: {
      ...leerMedio(f.get('medio')), monto: String(f.get('monto')).trim().replace(',', '.'), categoria: f.get('categoria'),
      descripcion: f.get('descripcion'), fecha: f.get('fecha') || hoyLima(), documento: f.get('documento'),
    } });
    e.target.reset();
    mensaje('#mensaje-gasto', '✔ Gasto registrado.');
    if (foto && foto.size) {
      try {
        await api(`/gastos/${id}/foto`, { cuerpo: { imagen: await fotoRecibo(foto) } });
        mensaje('#mensaje-gasto', '✔ Gasto registrado con la foto del recibo.');
      } catch (err) {
        mensaje('#mensaje-gasto', `El gasto se registró, pero la foto no se pudo subir: ${err.message}`, true);
      }
    }
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
