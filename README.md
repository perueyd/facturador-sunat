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
| 11. Panel web para emitir a mano (`/panel`) | ✅ Aprobada; tablero con vencimientos y funciones por empresa en revisión |
| Revisión de seguridad completa | ✅ Hecha (`docs/SEGURIDAD.md`) |
| 12. Plataforma para otros negocios (planes, invitaciones, vigilancia, secciones por plan) | ✅ Hecha (`docs/PLATAFORMA.md`) |
| 13. Caja, cuentas, cierre de caja, clientes frecuentes y WhatsApp, inventario (Kardex, reposición), app instalable y escáner | ✅ Hecha |
| 14. Panel simple (estilo Emprende), cotizaciones y devoluciones desde Vender, "ya declaré", cierre de caja con suma | ✅ Hecha |
| 15. Vender sin internet (boletas impresas de contingencia + archivo para SUNAT) | ✅ Hecha (`docs/PLAN.md` §21 y §23) |
| 16. Padrón de SUNAT (razón social de RUC 20), comprobantes emitidos en SUNAT, productos desde Excel, conexiones | ✅ Hecha |
| Prueba de carga y revisión de seguridad (07/11/2026) | ✅ Hecha (`docs/PLATAFORMA.md`, `docs/SEGURIDAD.md`) |
| Próximos módulos y lo que espera a SUNAT o al contador | 📋 `docs/PLATAFORMA.md` → Proyectos pendientes |

Hoy el sistema valida, calcula el IGV, numera sin saltos, guarda en PostgreSQL, genera
el XML, lo firma y lo envía a SUNAT **beta** con reintentos automáticos. Producción está
bloqueada hasta tu autorización y la lista "Antes de pasar a producción" de `docs/PLAN.md`.

## Cómo funciona (resumen)

1. Un canal (tienda web o panel manual) pide emitir un comprobante.
2. El facturador valida los datos (DNI, RUC, monto de S/ 700, régimen…).
3. Calcula el IGV con decimales exactos (el cliente paga exactamente el precio publicado).
4. Toma el siguiente número de la serie y guarda todo en una sola transacción.
5. Genera el XML UBL 2.1 que pide SUNAT.
6. Lo firma con el Certificado Digital Tributario de la empresa (guardado cifrado) y guarda el XML firmado.
7. Lo envía a SUNAT y guarda la constancia (CDR). Si SUNAT no responde, lo reintenta solo.
8. Genera el PDF con QR en A4 o ticket de 80 mm (a elección).
9. Otras páginas web (la de un cliente, una tienda) pueden emitir por la API, cada una con su llave
   (ver `docs/API.md`); el dueño las crea, ve y desconecta en el panel (Más → Conexiones con
   páginas web). Hoy la tienda web propia va independiente.
10. Sin internet se anota la boleta IMPRESA de contingencia en el celular; al volver la señal llega
    sola al facturador, que arma el archivo para informarla a SUNAT en 7 días.
11. Todas las pantallas (Inicio, Estadísticas, Caja, Excel del contador) suman lo emitido aquí, lo
    vendido sin internet y lo emitido en SUNAT y subido como XML (vista `ventas_todas`).

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

Quien vende el facturador puede dar de alta empresas desde el panel:
```bash
npm run usuario -- plataforma --email tu@correo.com
```

Cada empresa elige qué funciones del panel usa:
```bash
npm run empresa:modulos -- --ruc 20XXXXXXXXX                      # ver
npm run empresa:modulos -- --ruc 20XXXXXXXXX --desactivar cobros  # o --activar …
```

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

### Padrón de SUNAT (empresas)

```bash
curl -o padron.zip https://www2.sunat.gob.pe/padron_reducido_ruc.zip
unzip -p padron.zip | npm run padron     # en producción lo hace solo .github/workflows/padron.yml
```

## Publicarlo en internet

Guía paso a paso (Supabase + Render + GitHub Actions): [`docs/PUBLICAR.md`](docs/PUBLICAR.md).
Publicar NO es pasar a producción en SUNAT: sigue en BETA hasta tu autorización.

## Carpetas

| Carpeta | Qué hay |
|---|---|
| `src/calculos/` | IGV, totales y monto en letras |
| `src/validaciones/` | DNI, RUC y reglas de cada comprobante |
| `src/xml/` | Generación de XML (factura, boleta, notas de crédito y de débito, resumen diario, baja) |
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
| `src/reportes/` | Tablero, estadísticas, resultado del mes, venta rápida y clientes |
| `src/contingencia/` | Ventas sin internet (boletas impresas) y su archivo RF para SUNAT |
| `src/antiguos/` | Comprobantes emitidos en SUNAT (SOL, Emprende) subidos como XML |
| `src/padron/` | Padrón de SUNAT de empresas (razón social, estado y condición) |
| `src/cotizaciones/` | Cotizaciones (proformas) con su PDF |
| `src/panel/` | Panel web: rutas y la página (`publico/`) |
| `src/plataforma/` | Planes, suscripciones, aliados y vigilancia |
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
- [`docs/PUBLICAR.md`](docs/PUBLICAR.md) — publicar en Supabase + Render + GitHub Actions.
- [`docs/SEGURIDAD.md`](docs/SEGURIDAD.md) — qué está protegido y qué queda pendiente.
- [`docs/PLATAFORMA.md`](docs/PLATAFORMA.md) — el facturador como servicio, capacidad y prueba de carga.
- [`docs/REVISION_CONTADOR.md`](docs/REVISION_CONTADOR.md) — lo que debe revisar el contador antes de producción.
- [`docs/ejemplos/`](docs/ejemplos/) — XML y PDF de ejemplo con datos ficticios.
