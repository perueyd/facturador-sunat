# Guía para desarrolladores

Cómo está organizado el facturador, qué reglas sigue el código y cómo agregar cosas sin
romper nada. Las reglas de negocio obligatorias están en [`CLAUDE.md`](../CLAUDE.md).

## 1. Recorrido de un comprobante

```
POST /v1/comprobantes  (src/api/app.ts)
  │  leerPedido()            src/api/solicitud.ts      JSON → solicitud (montos como texto)
  ▼
emitirComprobante()          src/comprobantes/emitir.ts
  │  prepararComprobante()   src/comprobantes/preparar.ts   cálculos + validaciones (sin BD)
  │     calcularItems()      src/calculos/igv.ts
  │     validarComprobante() src/validaciones/comprobante.ts
  │  UPDATE series … RETURNING  (número sin saltos, en la misma transacción)
  │  INSERT comprobante + ítems + cuotas + evento + cola_envios + auditoría
  ▼
procesarAhora() / procesarCola()   src/cola/procesar.ts   (cron cada minuto)
  │  firmarComprobante()     src/comprobantes/firmar-comprobante.ts
  │     generarXmlComprobante()  src/xml/comprobante.ts
  │     firmarXml()              src/firma/firmar.ts
  │  ClienteSunatSoap.sendBill()  src/sunat/cliente.ts → leerCdr() src/sunat/cdr.ts
  │  ACEPTADO / ACEPTADO_OBS / RECHAZADO / PENDIENTE_ENVIO (+ alertas)
  ▼
pdfDeComprobante()           src/comprobantes/pdf-comprobante.ts → src/pdf/representacion.ts
```

## 2. Mapa de carpetas

| Carpeta | Responsabilidad | Toca la BD |
|---|---|---|
| `src/dinero.ts`, `src/calculos/` | Montos exactos, IGV, monto en letras | No |
| `src/validaciones/` | DNI, RUC y reglas de cada comprobante | No |
| `src/xml/` | XML UBL 2.1, resúmenes y bajas | No |
| `src/firma/` | Certificado `.pfx` y firma XMLDSig | Solo `repositorio-certificados.ts` |
| `src/sunat/` | Cliente SOAP, CDR, códigos de error, URLs y credenciales | Solo para leer datos |
| `src/pdf/` | Representación impresa con QR | No |
| `src/comprobantes/` | Casos de uso: emitir, firmar, anular, PDF | Sí |
| `src/cola/` | Envíos a SUNAT con reintentos | Sí |
| `src/api/` | HTTP: llaves, lectura del JSON, rutas | Sí |
| `src/empresas/` | Alta y configuración de empresas | Sí |
| `src/cobros/` | Pagos, saldo, cuotas, cuentas de cobro, caja, cierre y gastos | Sí |
| `src/inventario/` | Productos, movimientos de stock, compras y costo promedio | Sí |
| `src/devoluciones/` | Devolución = nota de crédito + stock + reembolso | Sí |
| `src/reportes/` | Resumen del día, tablero, estadísticas, clientes frecuentes, venta rápida (solo lectura) | Sí |
| `src/cotizaciones/` | Cotizaciones (proformas) y su PDF | Sí |
| `src/plataforma/` | Planes, suscripciones y vigilancia de la plataforma | Sí |
| `src/panel/` | Panel web: `rutas.ts` (acceso, sesión, comprobantes, empresa, usuarios) y `rutas-*.ts` por tema (ventas, inventario, cobros, plataforma); `comun-rutas.ts` con roles y ayudantes; `publico/` la página (`index.html`, `estilo.css` y el JavaScript partido por tema: `app.js` base, `ventas.js`, `acceso.js`, `plataforma.js`, `cobros.js`, `compras.js`, `ajustes.js`, que se cargan en ese orden y comparten sus funciones) | Sí |
| `src/config.ts` | Única lectura de variables de entorno | No |
| `db/migraciones/` | Estructura de la BD, en orden y sin editar las ya aplicadas | — |
| `scripts/` | Comandos de consola (delgados: llaman a `src/`) | — |
| `tests/` | Pruebas; `tests/db/` usa PostgreSQL real | — |

Regla de capas: lo puro (cálculos, XML, firma, PDF) no conoce la base de datos. Los casos de
uso (`src/comprobantes/`, `src/cola/`) unen las piezas, y la API solo traduce HTTP.

## 3. Convenciones (obligatorias)

- **Dinero:** `Decimal` de `src/dinero.ts`. Nunca `number` para montos. En la BD, `NUMERIC`,
  que `pg` devuelve como texto.
- **Transacciones:** `enTransaccion(db, tx => …)`. Si algo falla, se deshace todo, incluido
  el número de serie.
- **Concurrencia:** primero bloquear (`SELECT … FOR UPDATE`) y después consultar lo demás en
  otra sentencia. Un `JOIN` en la sentencia que bloquea puede leer datos viejos tras la espera
  (error real que encontraron las pruebas en la fase 3).
- **Nada se borra:** los disparadores de la BD impiden `DELETE` y cambios en comprobantes
  emitidos, historial y auditoría. Los cambios se hacen con nuevas filas o con cambios de estado.
- **Parámetros tributarios:** van en la tabla `parametros_tributarios`, con fecha de vigencia.
  Nunca escritos en el código.
- **Mensajes:** en español, para el dueño: qué pasó y qué hacer.
- **Secretos:** solo en variables de entorno o cifrados con `src/seguridad/cifrado.ts`
  (con contexto por empresa). Jamás en registros ni en la auditoría.
- **Fechas legales:** hora de Lima (`ahoraLima()`).

## 4. Cómo agregar…

**Un campo nuevo a la BD:** crea `db/migraciones/0NN_descripcion.sql` (número siguiente).
Nunca edites una migración que ya se aplicó en algún ambiente.

**Un parámetro tributario:** inserta una fila nueva con `vigente_desde` en una migración y
cierra la anterior con `vigente_hasta`.

**Un código de error de SUNAT con explicación:** actualiza `sunat_errores` con una migración
(como `006_explicaciones_errores.sql`).

**Un endpoint:** en `src/api/app.ts`, con su permiso (`requiere(c, 'permiso')`), y verifica
que el recurso sea de la empresa de la llave (404 si no). Prueba en `tests/db/api.test.ts`.

**Una ruta del panel:** en el `rutas-*.ts` de su tema (o uno nuevo, registrado desde `rutas.ts`).
Usa `conEmpresa(c)` para la sesión, revisa el módulo (`sinModulo`) y el rol (`ROLES_*` de
`comun-rutas.ts`), y prueba en `tests/db/panel.test.ts`.

**Un archivo nuevo del panel** (`src/panel/publico/`): agrégalo en `BASE` de `rutas.ts` (así entra en la
versión de la app), en `CASCARA` de `sw.js` (para abrir sin señal) y como `<script defer>` en `index.html`.

**Un comando de consola:** archivo en `scripts/` que solo lea argumentos y llame a una
función de `src/`. Regístralo en `package.json`.

## 5. Probar

```bash
npm run db:prueba                       # PostgreSQL local para pruebas (muestra la URL)
export DATABASE_URL_PRUEBAS=<url>
npm test                                # todas las pruebas: deben pasar al 100 %
npm run analizar                        # TypeScript estricto + knip (código y dependencias sin usar)
```

- Las pruebas de `tests/db/` borran y recrean la base, y solo corren en bases `*_pruebas`.
- `tests/sunat-simulado.ts` imita a SUNAT (acepta, rechaza, falla o se cuelga). Para probar
  contra SUNAT de verdad: `npm run sunat:beta -- --ruc <RUC>`.
- Los XML se validan contra el XSD oficial (`tests/xsd/`), las firmas con un verificador
  independiente en Python y los PDF escaneando el QR desde la imagen.

## 6. Antes de subir un cambio

1. `npm test` y `npm run analizar` sin errores.
2. ¿Hay archivos nuevos? Revisa `git status`: el `.gitignore` alguna vez ocultó carpetas de
   código. Sus reglas de carpetas empiezan con `/` para aplicar solo en la raíz.
3. Ninguna clave, certificado ni `.env` en el commit.
4. Actualiza `docs/` si cambiaste algo visible para el dueño o para quien integra la API.
