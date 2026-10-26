# API del facturador

API HTTP para que la tienda y otros canales pidan emitir comprobantes. Todas las
respuestas son JSON en español, salvo las descargas (PDF, XML y CDR).

## 1. Conceptos

- **Una llave por canal.** Cada página o canal tiene su propia llave de API. Si se filtra,
  se revoca solo esa, sin afectar a las demás.
- **Pedido = idempotencia.** Cada comprobante lleva el número de pedido de tu tienda. Si el
  mismo pedido llega dos veces, se devuelve el comprobante ya emitido; nunca se emite otro.
  Única excepción: si SUNAT **rechazó** el comprobante, el pedido puede emitir uno nuevo
  (con el siguiente número) después de corregir los datos. El rechazado se conserva.
- **Correlativo único por serie.** No importa desde qué canal se emita: `B001` sigue una
  sola numeración.
- **Montos como texto.** `"59.90"`, nunca `59.9`. Así no se arrastran errores de decimales
  desde la tienda. Las cantidades enteras pueden ir como número (`2`).
- **Ambiente.** Mientras la empresa esté en BETA, todo es de prueba (los PDF dicen
  "SIN VALOR LEGAL").

## 2. Preparar una empresa y su llave

```bash
# 1) Empresa, series (F001, B001, FC01, BC01), marca y canales (una sola vez)
npm run empresa:configurar -- --ruc 20XXXXXXXXX --razon "CORPORACION AGAMENON S.A.C." \
  --ubigeo 150101 --departamento LIMA --provincia LIMA --distrito LIMA \
  --direccion "AV. EJEMPLO 123" --regimen MYPE_TRIBUTARIO --desde 2026-01-01 \
  --marca "Espacios y Diseño"

# 2) Certificado digital (ver docs/GUIA_CERTIFICADO.md)
npm run certificado:cargar -- --ruc 20XXXXXXXXX --pfx "C:/ruta/segura/certificado.p12"

# 3) Llave para la tienda (se muestra UNA vez)
npm run llave-api -- crear --ruc 20XXXXXXXXX --canal "Tienda web"
```

Permisos de una llave: `emitir`, `consultar` y `cobrar` (los tres por defecto) y `anular`
(agrégalo solo si ese canal debe poder anular).

Otros comandos: `npm run llave-api -- listar --ruc …` y `npm run llave-api -- revocar --ruc … --prefijo …`.

## 3. Endpoints

Cabecera en todos (salvo `salud`): `Authorization: Bearer fk_xxxxxxxxxxxx_…`

| Método | Ruta | Para qué | Permiso |
|---|---|---|---|
| GET | `/v1/salud` | ¿El servicio está vivo? | — |
| POST | `/v1/comprobantes` | Emitir (y enviar a SUNAT al instante) | emitir |
| GET | `/v1/comprobantes?pedido=ED-1001` | Buscar por número de pedido | consultar |
| GET | `/v1/comprobantes/{id}` | Estado y datos | consultar |
| GET | `/v1/comprobantes/{id}/pdf?formato=A4\|TICKET_80` | PDF (sin `formato`: el del canal) | consultar |
| GET | `/v1/comprobantes/{id}/xml` | XML firmado | consultar |
| GET | `/v1/comprobantes/{id}/cdr` | Constancia de SUNAT (ZIP) | consultar |
| POST | `/v1/comprobantes/{id}/pagos` | Registrar un pago (`{"monto": "100.00", "medio": "YAPE", "referencia": "123456"}`; sin `monto`, cobra el saldo) | cobrar |
| POST | `/v1/comprobantes/{id}/anular` | Anular (`{"motivo": "…"}`) | anular |
| GET | `/v1/reportes/resumen-dia?fecha=AAAA-MM-DD` | Ventas, cobros por medio, por cobrar y pendientes con SUNAT | consultar |
| POST | `/v1/cola/procesar` | Cron: procesa la cola (clave `CLAVE_CRON`) | — |

### Emitir: `POST /v1/comprobantes`

```json
{
  "pedido": "ED-1001",
  "tipo": "BOLETA",
  "cliente": { "tipoDocumento": "DNI", "numero": "12345678", "nombre": "JUAN PÉREZ" },
  "items": [
    { "codigo": "TAR-001", "descripcion": "Tarima 2 plazas", "cantidad": 1, "precio": "350.00" },
    { "descripcion": "Almohada", "cantidad": 2, "precio": "59.90" }
  ]
}
```

| Campo | Obligatorio | Valores |
|---|---|---|
| `pedido` | sí | Número de pedido de tu tienda (máx. 100 caracteres) |
| `tipo` | sí | `BOLETA`, `FACTURA`, `NOTA_CREDITO` |
| `serie` | no | Por defecto `B001` / `F001` / `BC01` / `FC01` |
| `fecha` | no | `AAAA-MM-DD` (por defecto, hoy en Lima) |
| `marca` | no | Nombre de la marca (por defecto, la del canal) |
| `cliente.tipoDocumento` | no | `DNI`, `RUC`, `CE`, `PASAPORTE`, `NINGUNO` (por defecto `NINGUNO`: boletas de hasta S/ 700) |
| `cliente.numero`, `cliente.nombre`, `cliente.direccion` | según el caso | Factura: RUC y razón social obligatorios |
| `items[].precio` | sí | Precio unitario **con IGV**, como texto |
| `items[].codigo` | no | SKU del producto. Si existe en el inventario, descuenta stock y guarda el costo para el margen |
| `items[].cantidad` | no | Entero o texto (por defecto 1) |
| `items[].unidad` | no | `NIU` (unidad, por defecto) o `ZZ` (servicio) |
| `items[].afectacion` | no | `GRAVADO` (por defecto), `EXONERADO`, `INAFECTO` |
| `descuento` | no | Descuento total **con IGV** (cupón u oferta), como texto: `"50.00"`. El total queda en suma de ítems − descuento; en el comprobante va como descuento global que rebaja la base del IGV. `"0.00"` = sin descuento. Solo boletas y facturas, y solo sobre productos gravados |
| `formaPago` | no | `"CONTADO"` (por defecto) o `{ "cuotas": [{ "monto": "500.00", "vence": "2026-12-31" }] }` (solo facturas) |
| `notaCredito` | en NC | `{ "tipo": "FACTURA", "serie": "F001", "numero": 15, "motivo": "07", "descripcion": "Devolución" }` |
| `pago` | no | Pago ya confirmado: `{ "medio": "YAPE", "referencia": "nº de operación" }`. Se registra por el total y el comprobante queda `PAGADO`. Requiere el permiso `cobrar`. |

**Respuestas**

| Código | Significa |
|---|---|
| `201` | Emitido. `estado` dice qué respondió SUNAT (`ACEPTADO`, `ACEPTADO_OBS`, `RECHAZADO`) o `PENDIENTE_ENVIO` si SUNAT no respondió: se reintenta solo. |
| `200` | Ese pedido ya tenía comprobante: se devuelve el mismo (`"repetido": true`). |
| `422` | Datos inválidos: `error.detalles` dice qué corregir. |
| `401` / `403` | Llave inválida o revocada / la llave no tiene ese permiso. |
| `413` / `429` | Pedido de más de 100 KB / demasiados pedidos por minuto. |

```json
{
  "id": "7f1c…", "pedido": "ED-1001", "numero": "B001-00000015", "tipo": "03",
  "fecha": "2026-10-23", "estado": "ACEPTADO", "estadoPago": "PAGADO",
  "total": "469.80", "igv": "71.66", "descuento": "0.00", "saldo": "0.00",
  "pagos": [{ "id": "…", "fecha": "2026-10-23", "monto": "469.80", "medio": "YAPE", "referencia": "123456", "anulado": false }],
  "sunat": { "codigo": "0", "mensaje": "La Boleta numero B001-15, ha sido aceptada", "observaciones": [] },
  "enlaces": { "pdf": "/v1/comprobantes/7f1c…/pdf", "xml": "…/xml", "cdr": "…/cdr",
               "cliente": "https://facturador…/c/7f1c….k3x9a1.Qm…" },
  "repetido": false
}
```

**`enlaces.cliente`** abre el PDF **sin llave**: es para el cliente (la tienda lo muestra en el
seguimiento del pedido; también sirve para mandarlo por WhatsApp). Va firmado: no se puede
cambiar para ver otro comprobante, y vence al año (consultar el comprobante da uno nuevo).

## 4. Conectar la tienda (emitir solo cuando confirmas el pago Yape/Plin)

La regla es simple: **la tienda llama al facturador cuando tú marcas el pago como
confirmado**, nunca antes. La llave vive en las variables de entorno, no en el código.

### Opción A: desde la tienda en Vercel

En Vercel → *Settings → Environment Variables*: `FACTURADOR_URL` y `FACTURADOR_LLAVE`.

```js
// Llamar SOLO cuando el pago del pedido fue confirmado.
export async function emitirComprobante(pedido) {
  const r = await fetch(`${process.env.FACTURADOR_URL}/v1/comprobantes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FACTURADOR_LLAVE}` },
    body: JSON.stringify({
      pedido: pedido.id,                         // ej. "ED-1001"
      tipo: pedido.ruc ? 'FACTURA' : 'BOLETA',
      cliente: pedido.ruc
        ? { tipoDocumento: 'RUC', numero: pedido.ruc, nombre: pedido.razonSocial }
        : pedido.dni ? { tipoDocumento: 'DNI', numero: pedido.dni, nombre: pedido.nombre } : undefined,
      items: pedido.productos.map((p) => ({
        codigo: p.sku, descripcion: p.nombre, cantidad: p.cantidad,
        precio: String(p.precio),                 // ⚠️ mejor si la tienda ya guarda el precio como texto "350.00"
      })),
      pago: { medio: pedido.medioPago, referencia: pedido.numeroOperacion },  // "YAPE" o "PLIN"
    }),
  });
  const datos = await r.json();
  if (r.status === 422) throw new Error(datos.error.detalles.join('\n'));
  return datos;                                   // guarda datos.numero y datos.id en el pedido
}
```

### Opción B: desde la hoja "Pedidos ED" (Google Apps Script)

Si confirmas los pagos en la hoja de Google, un script puede emitir cuando cambias la
columna de pago a "Confirmado". En *Extensiones → Apps Script → Configuración del proyecto →
Propiedades del script* guarda `FACTURADOR_URL` y `FACTURADOR_LLAVE`.

```js
// ⚠️ Ajusta los números de columna a tu hoja. Activador: "Al editar" (instalable).
function alEditar(e) {
  const hoja = e.range.getSheet();
  if (hoja.getName() !== 'Pedidos ED' || e.range.getColumn() !== COL_ESTADO_PAGO || e.value !== 'Confirmado') return;
  const fila = hoja.getRange(e.range.getRow(), 1, 1, hoja.getLastColumn()).getValues()[0];
  const props = PropertiesService.getScriptProperties();
  const r = UrlFetchApp.fetch(props.getProperty('FACTURADOR_URL') + '/v1/comprobantes', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + props.getProperty('FACTURADOR_LLAVE') },
    payload: JSON.stringify({
      pedido: String(fila[COL_PEDIDO - 1]), tipo: 'BOLETA',
      items: [{ descripcion: fila[COL_PRODUCTO - 1], cantidad: Number(fila[COL_CANTIDAD - 1]), precio: Number(fila[COL_PRECIO - 1]).toFixed(2) }],
    }),
  });
  const datos = JSON.parse(r.getContentText());
  hoja.getRange(e.range.getRow(), COL_COMPROBANTE).setValue(datos.numero || ('ERROR: ' + JSON.stringify(datos.error)));
}
```

Si el pedido se reenvía por error, el facturador devuelve el mismo comprobante: no hay riesgo
de emitir dos veces. Y si envías el `pago` con su número de operación, tampoco se registra
dos veces el mismo pago.

## 5. Despliegue

Paso a paso en [`PUBLICAR.md`](PUBLICAR.md): base en Supabase (los XML y las constancias de
SUNAT se guardan en la misma base), servidor en Render (`render.yaml`), cola cada 5 minutos y
respaldo diario cifrado con GitHub Actions (`.github/workflows/`).
