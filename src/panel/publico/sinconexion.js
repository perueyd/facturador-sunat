// Panel del facturador · Vender sin internet (boletas IMPRESAS de contingencia).
//
// Sin señal no se puede emitir electrónicamente. SUNAT permite entonces entregar una boleta
// o factura IMPRESA por imprenta autorizada (serie de números, ej. 0001-123) e informarla
// dentro de 7 días. Aquí:
//   - Si no hay internet, Vender pide la serie y el número de la boleta impresa que se
//     entrega, y la venta se guarda EN ESTE CELULAR (nunca se pierde al cerrar la app).
//   - Al volver la señal, se envían solas al facturador (una sola vez cada una).
//   - El dueño o el contador descargan el archivo para SUNAT en Más → Para tu contador.
// El número de boleta lo pone la persona (el de la boleta impresa): el celular nunca inventa
// números de comprobantes electrónicos.
'use strict';

const CLAVE_COLA = 'ventas-sin-conexion';
const CLAVE_DATOS = 'panel-sin-conexion';
let modoSinConexion = false;

const colaSinConexion = () => {
  try { return JSON.parse(localStorage.getItem(CLAVE_COLA) || '[]'); } catch { return []; }
};
const guardarCola = (cola) => localStorage.setItem(CLAVE_COLA, JSON.stringify(cola));

/** Lo mínimo para poder vender sin señal: quién es, la empresa, canales y productos con su precio. */
function recordarParaSinConexion() {
  if (!yo?.empresa) return;
  localStorage.setItem(CLAVE_DATOS, JSON.stringify({
    yo: { nombre: yo.nombre, empresa: yo.empresa, empresas: [], canales: yo.canales, puedeEmitir: yo.puedeEmitir, bloqueadas: [], diasAtras: yo.diasAtras },
    productos: productos.map((p) => ({ nombre: p.nombre, sku: p.sku, precio: p.precio })),
    vendidos,
    guardado: new Date().toISOString(),
  }));
}

function olvidarDatosSinConexion() {
  localStorage.removeItem(CLAVE_DATOS);
}

/** Abre el panel sin señal con lo último que se guardó. Devuelve false si nunca se entró en este celular. */
function abrirSinConexion() {
  let datos;
  try { datos = JSON.parse(localStorage.getItem(CLAVE_DATOS) || 'null'); } catch { datos = null; }
  if (!datos?.yo?.empresa) return false;
  yo = datos.yo;
  productos = datos.productos ?? [];
  $('#vista-entrar').hidden = true;
  $('#vista-panel').hidden = false;
  $('#empresa-actual').hidden = false;
  $('#empresa-actual').textContent = `${yo.empresa.razonSocial} · ${yo.empresa.ruc}`;
  $('#canal').replaceChildren(...(yo.canales ?? []).map((c) => new Option(c, c)));
  vendidos = datos.vendidos ?? [];
  llenarSugerencias();
  // Sin señal solo se vende: las demás pestañas necesitan al facturador.
  for (const b of document.querySelectorAll('#pestanas button')) b.hidden = b.dataset.pestana !== 'vender';
  abrirPestana('vender').catch(() => {});
  ponerModoSinConexion(true);
  return true;
}

/** Cambia Vender entre emitir (con señal) y anotar la boleta impresa (sin señal). */
function ponerModoSinConexion(activo) {
  modoSinConexion = activo;
  $('#aviso-sin-conexion').hidden = !activo;
  $('#caja-contingencia').hidden = !activo;
  for (const campo of $('#caja-contingencia').querySelectorAll('input')) campo.required = activo;
  // Lo que necesita al facturador se oculta: venta otro día, crédito y cotizaciones.
  $('#caja-fecha-venta').hidden = activo;
  $('#caja-cotizar').hidden = activo;
  if (activo) {
    $('#forma-pago').value = 'CONTADO';
    $('#caja-cuotas').hidden = true;
    const ultima = JSON.parse(localStorage.getItem('ultima-boleta-impresa') || 'null');
    if (ultima && !$('#serie-impresa').value) {
      $('#serie-impresa').value = ultima.serie;
      $('#numero-impresa').value = String(ultima.numero + 1);
    }
  }
  textoBotonEmitir();
  mostrarPorEnviar();
}

const colaDeLaEmpresa = () => colaSinConexion().filter((x) => x.empresaId === yo?.empresa?.id);

function mostrarPorEnviar() {
  const n = colaDeLaEmpresa().length;
  const b = $('#ventas-por-enviar');
  b.hidden = n === 0;
  b.textContent = n === 1 ? '📵 1 venta sin internet por enviar' : `📵 ${n} ventas sin internet por enviar`;
  b.classList.toggle('urgente', colaDeLaEmpresa().some((x) => x.error));
}

/** Dígito verificador del RUC (módulo 11), igual que en el facturador. */
function rucValido(ruc) {
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((t, p, i) => t + p * Number(ruc[i]), 0);
  const r = 11 - (suma % 11);
  return (r === 10 ? 0 : r === 11 ? 1 : r) === Number(ruc[10]);
}

/** Guarda en el celular la venta hecha con boleta impresa. */
function anotarSinConexion(cuerpo) {
  const serie = $('#serie-impresa').value.trim();
  const numero = Number($('#numero-impresa').value.trim());
  if (!/^\d{4}$/.test(serie)) throw new Error('La serie de la boleta impresa son 4 números (ej. 0001).');
  if (!Number.isSafeInteger(numero) || numero < 1) throw new Error('Escribe el número de la boleta impresa que entregaste.');
  // Lo que se puede revisar sin el facturador (él lo vuelve a revisar todo al recibirla).
  const doc = cuerpo.cliente?.tipoDocumento;
  const num = cuerpo.cliente?.numero ?? '';
  if (doc === 'DNI' && !/^\d{8}$/.test(num)) throw new Error('El DNI tiene 8 números.');
  if (doc === 'RUC' && !rucValido(num)) throw new Error('El RUC no es válido: revisa los 11 números.');
  if (cuerpo.tipo === 'FACTURA' && (doc !== 'RUC' || !cuerpo.cliente?.nombre)) throw new Error('La factura necesita el RUC y la razón social del cliente.');
  if (!cuerpo.items.length || cuerpo.items.some((x) => !x.descripcion || !/^\d+(\.\d{1,2})?$/.test(x.precio))) throw new Error('Revisa los productos: cada uno con descripción y precio.');
  const cola = colaSinConexion();
  if (colaDeLaEmpresa().some((x) => x.cuerpo.contingencia.serie === serie && x.cuerpo.contingencia.numero === numero && x.cuerpo.tipo === cuerpo.tipo)) {
    throw new Error(`La ${cuerpo.tipo === 'FACTURA' ? 'factura' : 'boleta'} impresa ${serie}-${numero} ya está anotada.`);
  }
  const ahora = new Date();
  const hora = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ahora);
  const { pedido: _pedido, fecha: _fecha, formaPago: _forma, ...resto } = cuerpo;
  cola.push({
    // De qué empresa es: en un mismo celular pueden entrar personas de empresas distintas.
    empresaId: yo.empresa.id,
    cuerpo: { ...resto, contingencia: { origen: `SINRED-${crypto.randomUUID()}`, serie, numero, fecha: hoyLima(), hora, anotadoEn: ahora.toISOString() } },
  });
  guardarCola(cola);
  localStorage.setItem('ultima-boleta-impresa', JSON.stringify({ serie, numero }));
  $('#numero-impresa').value = String(numero + 1);
  mostrarPorEnviar();
  return `${serie}-${numero}`;
}

let enviando = false;
/** Manda al facturador las ventas guardadas en el celular, una por una y en orden. */
async function enviarPendientes() {
  if (enviando || !navigator.onLine || !colaDeLaEmpresa().length) return;
  enviando = true;
  try {
    for (const venta of colaSinConexion().filter((x) => x.empresaId === yo?.empresa?.id)) {
      let quitar = false;
      try {
        await api('/contingencia', { cuerpo: venta.cuerpo });
        quitar = true;
      } catch (err) {
        if (err instanceof TypeError) break; // se cortó otra vez la señal: se reintenta después
        // El facturador la rechazó (ej. número repetido): queda en el celular con el motivo.
        const cola = colaSinConexion();
        const x = cola.find((y) => y.cuerpo.contingencia.origen === venta.cuerpo.contingencia.origen);
        if (x) { x.error = [err.message, ...(err.detalles || [])].join(' '); guardarCola(cola); }
        if (/sesión|entrar/i.test(err.message)) break;
      }
      if (quitar) guardarCola(colaSinConexion().filter((y) => y.cuerpo.contingencia.origen !== venta.cuerpo.contingencia.origen));
    }
  } finally {
    enviando = false;
    mostrarPorEnviar();
    dibujarPorEnviar();
  }
}

/** La lista de lo que está en el celular, con el motivo si el facturador rechazó alguna. */
function dibujarPorEnviar() {
  const lista = $('#lista-por-enviar');
  const cola = colaDeLaEmpresa();
  $('#caja-por-enviar').hidden = cola.length === 0;
  lista.replaceChildren(...cola.map((x) => {
    const k = x.cuerpo.contingencia;
    const li = linea(`${x.cuerpo.tipo === 'FACTURA' ? 'Factura' : 'Boleta'} impresa ${k.serie}-${k.numero} · ${k.fecha} ${k.hora}`, x.error ? '⚠️ revisar' : 'por enviar', x.error ? 'error' : '');
    if (x.error) li.title = x.error;
    if (x.error) li.append(Object.assign(document.createElement('small'), { textContent: x.error }));
    return li;
  }));
}

/** Más → Para tu contador: días con ventas sin internet y su archivo para SUNAT. */
async function cargarContingencia() {
  const caja = $('#caja-informar-contingencia');
  caja.hidden = !(yo?.empresa && ['DUENO', 'ADMIN', 'CONTADOR'].includes(yo.empresa.rol));
  if (caja.hidden) return;
  const { dias } = await api('/contingencia');
  const lista = $('#lista-contingencia');
  if (!dias.length) {
    lista.replaceChildren(Object.assign(document.createElement('li'), { className: 'vacio', textContent: 'No hay ventas sin internet en los últimos 60 días.' }));
    return;
  }
  lista.replaceChildren(...dias.map((d) => {
    const estado = d.informado ? '✔ archivo descargado' : d.diasRestantes < 0 ? `⚠️ VENCIÓ el ${d.vence}` : `informar hasta el ${d.vence} (${d.diasRestantes} días)`;
    const li = linea(`${d.fecha} · ${d.ventas.length} venta(s) · S/ ${d.total}`, estado, d.informado ? '' : 'urgente');
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'secundario', textContent: d.informado ? 'Descargar de nuevo' : 'Descargar archivo para SUNAT' });
    b.addEventListener('click', async () => {
      await descargar(await api('/contingencia/informe', { cuerpo: { fecha: d.fecha }, crudo: true }), `contingencia-${d.fecha}.zip`);
      await cargarContingencia();
    });
    li.append(b);
    return li;
  }));
}

window.addEventListener('offline', () => { if (yo) ponerModoSinConexion(true); });
window.addEventListener('online', () => {
  if (!yo) return;
  ponerModoSinConexion(false);
  // Si el panel se abrió sin señal, ahora se carga completo (y eso envía lo pendiente).
  if (!yo.email) cargarPanel().catch(mostrarEntrar);
  else enviarPendientes();
});
// Por si el aviso de "volvió la señal" no llega (pasa en algunos celulares).
setInterval(() => { if (navigator.onLine && colaDeLaEmpresa().length && yo?.email) enviarPendientes(); }, 60_000);
