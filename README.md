# Facturador electrónico SUNAT

Facturador propio para emitir boletas, facturas, notas de crédito y comunicaciones
de baja directamente a SUNAT (SEE - Del Contribuyente), sin proveedores externos.

## Estado

| Fase | Estado |
|---|---|
| 1. Plan y diseño de base de datos | ✅ Aprobada |
| 2. Generación de XML | ✅ Aprobada |
| 3. Firma digital | ✅ Aprobada |
| 4. Envío a SUNAT beta | ✅ Aprobada (prueba real en beta superada) |
| 5. PDF con QR | ✅ Aprobada (A4 y ticket 80 mm) |
| 6. API y conexión con la tienda | ✅ Aprobada (descuento global probado en beta) |
| 7. Cobros y estado de pago | ✅ Aprobada |
| 8. Inventario, compras y margen | ✅ Aprobada |
| 9. Listo para publicar (Supabase + Render) | ✅ Lista: falta que la publiques (`docs/PUBLICAR.md`) |
| 10. Devoluciones | ✅ Aprobada |
| 9b. Publicado (Render + Supabase + cron-job.org) | ✅ En línea, en beta |
| 11. Panel web para emitir a mano (`/panel`) | 🔎 Lista para tu revisión |
| Revisión de seguridad completa | ✅ Hecha (`docs/SEGURIDAD.md`) |

Hoy el sistema valida, calcula el IGV, numera sin saltos, guarda en PostgreSQL, genera
el XML, lo firma y lo envía a SUNAT **beta** con reintentos automáticos. Producción está
bloqueada hasta tu autorización.

## Cómo funciona (resumen)

1. Un canal (tienda web o panel manual) pide emitir un comprobante.
2. El facturador valida los datos (DNI, RUC, monto de S/ 700, régimen…).
3. Calcula el IGV con decimales exactos (el cliente paga exactamente el precio publicado).
4. Toma el siguiente número de la serie y guarda todo en una sola transacción.
5. Genera el XML UBL 2.1 que pide SUNAT.
6. Lo firma con el Certificado Digital Tributario de la empresa (guardado cifrado) y guarda el XML firmado.
7. Lo envía a SUNAT y guarda la constancia (CDR). Si SUNAT no responde, lo reintenta solo.
8. Genera el PDF con QR en A4 o ticket de 80 mm (a elección).
9. La tienda y otros canales emiten por la API, cada uno con su llave (ver `docs/API.md`).

## Cómo usarlo (para desarrollo)

Necesitas Node.js 22 o superior y PostgreSQL 15 o superior. Para las pruebas, además:
`xmllint` (valida el esquema UBL), `pdftotext`/`pdftoppm`/`pdfinfo` (poppler-utils) y Python 3
con `lxml` y `cryptography` (verificador independiente de firmas).

```bash
npm install                      # instala las librerías

npm run db:prueba                # levanta una base de datos de pruebas local y muestra su URL
export DATABASE_URL_PRUEBAS=...  # pega la URL que mostró el paso anterior
npm test                         # corre TODAS las pruebas (deben pasar al 100 %)
npm run analizar                 # TypeScript estricto + código sin usar (knip)

npm run typecheck                # revisa los tipos de TypeScript
npm run ejemplos                 # genera XML de ejemplo en docs/ejemplos/
```

Para crear las tablas en una base real (Supabase/Neon):

```bash
cp .env.example .env             # y completa DATABASE_URL (nunca subas .env a GitHub)
npm run db:migrar                # los comandos leen .env solos
```

### Cargar el certificado digital de una empresa

¿Aún no lo tienes? Sigue la guía [`docs/GUIA_CERTIFICADO.md`](docs/GUIA_CERTIFICADO.md).

1. Genera la llave maestra (una sola vez por ambiente) y guárdala en `LLAVE_MAESTRA`
   y en un gestor de contraseñas: `npm run llave:generar`
2. Carga el `.pfx` (la contraseña se pide por teclado y no se muestra):
   ```bash
   npm run certificado:cargar -- --ruc 20XXXXXXXXX --pfx /ruta/fuera/del/proyecto/certificado.pfx
   ```
3. Guarda el `.pfx` original en un lugar seguro **fuera** de la carpeta del proyecto.
   Nunca lo subas a GitHub.

### Probar contra SUNAT beta

```bash
npm run sunat:beta -- --ruc 20XXXXXXXXX
```
Detalles en [`docs/PRUEBA_BETA.md`](docs/PRUEBA_BETA.md).

### Servidor de la API

```bash
npm run empresa:configurar -- …   # empresa, series, marca y canales (ver docs/API.md)
npm run llave-api -- crear --ruc 20XXXXXXXXX --canal "Tienda web"
npm run servidor                  # API en http://localhost:3000
```

### Panel web (emitir a mano)

```bash
npm run usuario -- crear --email tu@correo.com --nombre "Tu nombre" --ruc 20XXXXXXXXX --rol DUENO
```
Pide una contraseña y muestra un QR para Google Authenticator. Luego entra a
`<dirección del facturador>/panel` con correo + contraseña + el código de 6 dígitos.

### Inventario y reportes

```bash
npm run inventario -- producto --ruc 20XXXXXXXXX --sku TAR-001 --nombre "Tarima 2 plazas" --precio 350.00 --minimo 2
npm run inventario -- compra   --ruc 20XXXXXXXXX --archivo compra.json   # factura del proveedor
npm run inventario -- stock    --ruc 20XXXXXXXXX
npm run reporte -- margen      --ruc 20XXXXXXXXX                         # margen de la semana (estimado)
npm run reporte -- cliente     --ruc 20XXXXXXXXX --documento 12345678
npm run devolucion -- --ruc 20XXXXXXXXX --comprobante B001-15 --items 1:1 --motivo "Cliente desistió" --reembolso YAPE
```
Detalles y formato del JSON en el encabezado de `scripts/inventario.ts` y `scripts/reporte.ts`.

### Procesar la cola de envíos

```bash
npm run cola:procesar     # una vuelta; en producción se programa cada minuto
```

## Publicarlo en internet

Guía paso a paso (Supabase + Render + GitHub Actions): [`docs/PUBLICAR.md`](docs/PUBLICAR.md).
Publicar NO es pasar a producción en SUNAT: sigue en BETA hasta tu autorización.

## Carpetas

| Carpeta | Qué hay |
|---|---|
| `src/calculos/` | IGV, totales y monto en letras |
| `src/validaciones/` | DNI, RUC y reglas de cada comprobante |
| `src/xml/` | Generación de XML (factura, boleta, nota de crédito, resumen diario, baja) |
| `src/firma/` | Certificado digital y firma XMLDSig |
| `src/seguridad/` | Cifrado de datos sensibles (AES-256-GCM) |
| `src/almacen/` | Guardado de archivos (XML firmados) sin sobrescribir |
| `src/comprobantes/` | Emisión, firma y anulación de comprobantes |
| `src/sunat/` | Cliente del servicio web de SUNAT, CDR y códigos de error |
| `src/cola/` | Cola de envíos con reintentos automáticos |
| `src/pdf/` | Representación impresa (PDF A4 y ticket) con QR |
| `src/api/` | API HTTP, llaves por canal y lectura de pedidos |
| `src/empresas/` | Alta y configuración de empresas |
| `src/cobros/` | Pagos, saldo, cuotas y vencimientos |
| `src/inventario/` | Productos, stock y compras a proveedores |
| `src/devoluciones/` | Devoluciones: nota de crédito, stock y reembolso |
| `src/reportes/` | Resumen del día, margen semanal e historial de clientes |
| `db/migraciones/` | Estructura de la base de datos (SQL) |
| `tests/` | Pruebas automáticas |
| `docs/` | Plan, diseño de la base de datos y ejemplos de XML |

## Documentos

- [`CLAUDE.md`](CLAUDE.md) — reglas obligatorias del proyecto.
- [`docs/DESARROLLO.md`](docs/DESARROLLO.md) — guía para desarrolladores: arquitectura, convenciones y cómo agregar cosas.
- [`docs/API.md`](docs/API.md) — API para la tienda y otros canales.
- [`docs/PLAN.md`](docs/PLAN.md) — cómo funciona, arquitectura, fases y lo revisado de SUNAT.
- [`docs/BASE_DE_DATOS.md`](docs/BASE_DE_DATOS.md) — diseño de la base de datos.
- [`docs/GUIA_CERTIFICADO.md`](docs/GUIA_CERTIFICADO.md) — cómo obtener el certificado digital en SUNAT.
- [`docs/PRUEBA_BETA.md`](docs/PRUEBA_BETA.md) — cómo hacer la prueba real en SUNAT beta.
- [`docs/ejemplos/`](docs/ejemplos/) — XML y PDF de ejemplo con datos ficticios.
