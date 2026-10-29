# Plan del facturador electrónico — Fase 1 (plan y diseño)

> Estado: fases 1 a 4 aprobadas (prueba real en beta superada); fases 5, 6 y 7 listas para revisión (secciones 10 a 12).
> Fecha: 23-oct-2026.

---

## 1. Resumen en palabras simples

Vamos a construir un "servicio facturador" propio. Funciona así:

1. Un canal (tu tienda web, o tú desde el panel manual) dice: *"emite una boleta
   por este pedido"*.
2. El facturador revisa que los datos estén bien (DNI, RUC, montos, IGV).
3. Le asigna el siguiente número de la serie (ej. `B001-00000015`) sin saltos.
4. Arma el archivo **XML** con el formato que pide SUNAT (UBL 2.1).
5. Lo **firma** con el Certificado Digital Tributario de la empresa.
6. Lo **envía** a SUNAT. SUNAT responde con una constancia llamada **CDR**
   (aceptado, aceptado con observaciones o rechazado).
7. Guarda el XML, el CDR y genera un **PDF con código QR** para el cliente.
8. Si SUNAT no responde, el comprobante queda "pendiente" y se reintenta solo.

---

## 2. Lo que revisé de SUNAT (y lo que falta confirmar)

Revisé fuentes oficiales y secundarias. Desde este entorno **no pude abrir
directamente sunat.gob.pe** (bloqueo de red), así que todo lo marcado con ⚠️ debe
confirmarse en la documentación oficial antes de programar la fase que lo use.
Esto es parte de la regla "no asumir nada de memoria".

| Tema | Lo encontrado | Confianza |
|---|---|---|
| Sistema | SEE - Del Contribuyente, creado por R.S. 097-2012/SUNAT. | Alta (oficial) |
| Formato | XML UBL 2.1, firmado (XMLDSig, RSA-SHA256), comprimido en ZIP. | Alta |
| Envío facturas/NC/boletas | Servicio SOAP `billService`. Beta: `https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService`. Producción: `https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService`. Métodos: `sendBill` (respuesta inmediata con CDR), `sendSummary` + `getStatus` (resúmenes y bajas, respuesta con ticket). | Media ⚠️ (URLs vistas en fuentes no oficiales, coinciden entre sí) |
| Guías de remisión | Usan otra API (REST con OAuth2). **No están en el alcance** por ahora. | Alta (manual oficial GRE) |
| Plazo facturas | Hasta 3 días calendario para enviar a SUNAT. | Media ⚠️ (el punto de inicio del conteo varía según la fuente) |
| Boletas | Se pueden enviar una por una o en **resumen diario**; plazo del resumen: hasta 7 días calendario desde la emisión. | Media ⚠️ |
| Baja de facturas | Comunicación de baja, hasta el 7.º día calendario. | Media ⚠️ |
| Baja de boletas | Se informan como "anuladas" en el resumen diario. | Media ⚠️ |
| Fuera de plazo | Ya no se puede dar de baja: se emite nota de crédito. | Alta |
| **Cambio 2027** | R.S. 000048-2026/SUNAT cambia reglas de emisión y baja; la R.S. 000143-2026/SUNAT **postergó su vigencia al 1-ene-2027** (algunas partes al 1-abr-2027). Hay que leer el texto oficial para ver si afecta facturas y boletas. | Media ⚠️ **Importante** |
| Boleta > S/ 700 | Obligatorio tipo y número de documento del cliente (R.S. 007-99, Anexo de R.S. 303-2018 y 114-2019). | Alta (oficial) |
| UIT 2026 | S/ 5,500. | Alta |
| Régimen MYPE | Hasta 1,700 UIT. Pago a cuenta 1 % de ingresos netos hasta 300 UIT; renta anual 10 % hasta 15 UIT de renta neta y 29.5 % por el exceso. | Media ⚠️ |
| Nuevo RUS | Límite S/ 96,000 al año / S/ 8,000 mensuales; no emite facturas. | Media ⚠️ |
| Taxi (RUC 10) | Exonerado de IGV (Apéndice II, num. 2 de la Ley del IGV). Una fuente indica prórroga hasta 31-dic-2028 (Ley 32542). **Ojo:** la comisión de apps (Uber, InDrive, etc.) sí está gravada (Informe 000107-2025-SUNAT/7T0000). | Media ⚠️ |
| Homologación | Antes, SUNAT pedía un "set de pruebas" para habilitar el SEE - Del Contribuyente. Confirmar si sigue vigente y cómo se pide en SOL. | Baja ⚠️ |

**Documentos oficiales a descargar y leer antes de la fase 2** (de
`cpe.sunat.gob.pe` y `sunat.gob.pe/legislacion`):

1. Guías de elaboración XML UBL 2.1: factura, boleta, nota de crédito, resumen
   diario y comunicación de baja (versión vigente).
2. Catálogos de SUNAT (Anexo 8): tipos de documento, afectación del IGV, motivos
   de nota de crédito, unidades de medida, etc.
3. Listado de códigos de error y observaciones (validaciones de SUNAT).
4. Manual del servicio web `billService` (WSDL).
5. Textos de R.S. 000048-2026 y 000143-2026.

---

## 3. Arquitectura propuesta

```
 Tienda (Vercel)      Panel manual (celular)     Otros canales
        │  llave API          │ login + 2FA            │ llave API
        └──────────────┬──────┴────────────────────────┘
                       ▼
              ┌──────────────────┐
              │  API facturador  │  valida, numera, guarda (transacción)
              └────────┬─────────┘
                       ▼
              ┌──────────────────┐      ┌───────────────────────┐
              │   PostgreSQL     │◄────►│ Cola de envíos        │
              │ (multiempresa)   │      │ (tabla + trabajador)  │
              └──────────────────┘      └──────────┬────────────┘
                                                   ▼
                                  XML UBL 2.1 → firma → ZIP → SUNAT
                                                   │
                                                   ▼
                          Almacenamiento de archivos (XML, CDR, PDF)
                          inmutable, con respaldo, 5+ años
```

### Tecnología recomendada

| Pieza | Propuesta | Por qué |
|---|---|---|
| Lenguaje | Node.js 22 + TypeScript estricto | Lo pediste; buen soporte de XML y firma. |
| API | Hono (framework web pequeño) | Corre igual en Vercel y en un servidor normal. |
| Base de datos | PostgreSQL administrado (Neon o Supabase) | Transacciones, respaldos automáticos y restauración a un punto en el tiempo. |
| Acceso a BD | Kysely o Drizzle + migraciones SQL versionadas | Consultas tipadas; el SQL queda visible y revisable. |
| Dinero | `decimal.js` + columnas `NUMERIC` | Sin errores de punto flotante. |
| XML / firma | `xmlbuilder2`, `xml-crypto`, `node-forge` (leer .pfx) | Librerías estándar, sin depender de un proveedor. |
| PDF + QR | `pdfkit` + `qrcode` | Funciona en servidor sin navegador. |
| Archivos | Almacenamiento tipo S3 (Cloudflare R2, Supabase Storage o Vercel Blob) con versionado | Los XML/CDR no se pueden perder ni sobrescribir. |
| Pruebas | Vitest + base de datos de prueba + SUNAT beta | Pruebas obligatorias. |

### Una advertencia sobre Vercel (te explico una opción mejor para la cola)

La API puede vivir en Vercel sin problema. El punto delicado es la **cola de
reintentos**: necesita revisarse cada pocos minutos. En el plan gratuito de
Vercel los "cron" solo corren una vez al día. Opciones:

1. **Vercel Pro** (de pago): cron cada minuto. Simple.
2. **Vercel gratis + `pg_cron` de Supabase** que llama al facturador cada minuto.
3. **Servidor pequeño siempre encendido** (Railway, Render o Fly.io) solo para el
   trabajador de la cola, y la API en Vercel.

**Mi recomendación:** opción 2 para empezar (bajo costo), dejando el código listo
para pasar a la 1 o la 3 sin cambios. Además, cuando un canal pide emitir, el
facturador intenta enviar a SUNAT de inmediato; la cola es solo la red de seguridad.

---

## 4. Cómo se cumplen las reglas obligatorias

| Regla | Cómo |
|---|---|
| Correlativos sin saltos ni duplicados | Tabla `series` con `ultimo_numero`. Dentro de UNA transacción: se bloquea la fila de la serie (`SELECT … FOR UPDATE`), se suma 1 y se inserta el comprobante. Si algo falla, todo se deshace y el número no se consume. Restricción única `(empresa, tipo, serie, número)` como segundo candado. |
| Pedido repetido | Restricción única `(empresa, canal, pedido_externo)` y encabezado `Idempotency-Key`. Si ya existe, se devuelve el mismo comprobante. |
| Validaciones | DNI 8 dígitos; RUC 11 dígitos con dígito verificador (módulo 11); documento obligatorio en boleta > S/ 700 (parámetro); RUC + razón social en factura; régimen permite el tipo de comprobante. |
| IGV exacto | Precios con IGV incluido → valor unitario sin IGV calculado con hasta 10 decimales (lo que permite SUNAT ⚠️), totales redondeados a 2 decimales con reglas fijas y probadas. |
| SUNAT no responde | Estado `PENDIENTE_ENVIO`, reintentos con espera creciente (1, 2, 5, 10, 30 min…). Alerta si pasa cierto tiempo o se acerca el plazo legal. |
| Errores claros | Tabla `sunat_errores` con el código oficial + explicación en español + qué corregir. |
| Nunca borrar | Sin `DELETE` en comprobantes (bloqueado por permisos de la base de datos). Cambios de estado registrados en `comprobante_eventos`. |
| Log y respaldo 5 años | `auditoria` de cada acción; XML/CDR en almacenamiento inmutable con hash SHA-256 en la base de datos; respaldo diario. |
| Beta primero | Cada empresa tiene `ambiente_sunat` = `BETA` por defecto. Pasar a `PRODUCCION` requiere un rol "dueño" + confirmación 2FA + registro en auditoría. |

### Estados de un comprobante

```
BORRADOR → EMITIDO_LOCAL → (envío) → ACEPTADO
                                   → ACEPTADO_CON_OBSERVACIONES
                                   → RECHAZADO  (se corrige emitiendo uno nuevo)
              ↓ sin respuesta
          PENDIENTE_ENVIO → reintento automático

Después de aceptado: ANULACION_EN_PROCESO → ANULADO (baja / resumen)
                     o queda vigente y se emite NOTA DE CRÉDITO.
```

---

## 5. Fases

| # | Fase | Qué se entrega | Cómo se prueba |
|---|---|---|---|
| 1 | Plan y diseño de BD | Este documento, `BASE_DE_DATOS.md`, `CLAUDE.md` | Tu aprobación |
| 2 | Generación de XML | Migraciones de BD, cálculos de IGV, validaciones, correlativos, XML de boleta, factura, NC, resumen diario y baja | Pruebas automáticas vs. ejemplos oficiales |
| 3 | Firma | Lectura del certificado (.pfx) desde variable de entorno/BD cifrada, firma XMLDSig | Verificar firma con certificado de prueba |
| 4 | Envío a SUNAT beta | Cliente SOAP, cola con reintentos, lectura de CDR, tabla de errores en español | Comprobantes aceptados en beta; simulación de SUNAT caído |
| 5 | PDF | Representación impresa con QR (formato A4 y ticket 80 mm) | Revisión visual + contador |
| 6 | API y tienda | Endpoints, llaves por canal, documentación, conexión con `tarimas-cabeceras-store` (emitir solo al confirmar Yape/Plin) | Pedido repetido no duplica; prueba de punta a punta |
| 7+ | Módulos futuros | Uno por fase (ver abajo) | — |

Orden sugerido de módulos futuros: (a) cobros y estado de pago, (b) inventario y
compras, (c) devoluciones, (d) crédito fiscal y SIRE, (e) finanzas e impuestos,
(f) conciliación bancaria, (g) perfil taxista, (h) dashboard completo,
(i) venta a otros negocios, (j) guías de remisión electrónicas (GRE).

**Accesos de SUNAT que pedirán los módulos futuros** (se configuran cuando lleguemos a cada uno):

- Validar facturas de proveedores y SIRE: credenciales de API (client_id / client_secret) generadas en SOL.
- Guías de remisión electrónicas: API REST de SUNAT con OAuth2 (distinta del servicio de facturas) y
  sus propios permisos para el usuario secundario.
- Usuario SOL secundario actual del facturador: solo "Servicio de Envío de Documentos Electrónicos
  por Servicio Web" y las 4 opciones de "Consultar Envíos de CPE".

Al final de cada fase: revisión de seguridad + tu aprobación antes de unir a `main`.

---

## 6. Antes de pasar a producción (lista obligatoria)

- [ ] Boletas, facturas y notas de crédito aceptadas en SUNAT beta, sin errores
- [ ] Pruebas automáticas pasando al 100 %
- [ ] Un contador revisó boletas y facturas de prueba
- [ ] Probado que un pedido repetido no genera dos comprobantes
- [ ] Probado qué pasa si SUNAT no responde (queda pendiente y se reenvía)
- [ ] Ningún certificado ni clave aparece en GitHub
- [ ] Respaldo diario funcionando y restaurado al menos una vez de prueba
- [ ] Revisión de seguridad final hecha
- [ ] Confirmado si SUNAT exige homologación / autorización previa del SEE - Del Contribuyente
- [ ] Revisado el impacto de R.S. 000048-2026 (vigente desde 1-ene-2027)

Antes de vender a otros negocios: confirmar con un contador o abogado tributario
si debes inscribirte como **PSE** (Proveedor de Servicios Electrónicos), y tener
política de privacidad y términos de uso.

---

## 7. Fase 2 — Generación de XML (resultado)

**Qué quedó hecho**

- Migraciones de la base de datos: núcleo, parámetros, comprobantes, cola,
  resúmenes, bajas y auditoría (`db/migraciones/`).
- Cálculo de IGV con precio incluido, sin errores de punto flotante.
- Validaciones: DNI, RUC con dígito verificador, boleta > S/ 700 (parámetro),
  factura con RUC y razón social, régimen (Nuevo RUS sin facturas), series F/B,
  cuotas de crédito, motivos de nota de crédito, exoneraciones vigentes,
  caracteres inválidos y máximo de decimales.
- Emisión en una sola transacción: correlativo sin saltos, pedido repetido
  devuelve el mismo comprobante, nota de crédito nunca supera el saldo del original.
- XML UBL 2.1 de factura, boleta y nota de crédito (validados contra el esquema
  oficial OASIS UBL 2.1), resumen diario (RC) y comunicación de baja (RA).
- Protecciones en la base: no se pueden borrar comprobantes, no se puede
  cambiar su contenido después de emitido, la serie no retrocede, historial y
  auditoría solo de inserción, no se pasa a producción sin registrar quién autorizó.
- 111 pruebas automáticas, incluidas 40 emisiones simultáneas y 10 pedidos
  repetidos simultáneos contra PostgreSQL real.

**Decisiones tomadas por defecto** (las preguntas de la fase 1 seguían abiertas;
se puede cambiar cualquiera sin rehacer el trabajo):

| Pregunta | Decisión provisional |
|---|---|
| Repositorio | Resuelto: renombrado a `facturador-sunat` (23/10/2026). |
| Base de datos | Cualquier PostgreSQL 15 o superior (Supabase y Neon cumplen). |
| Envío de boletas | Una por una (el diseño también soporta resumen diario, que se usa para anular boletas). |
| Series | Compartidas entre marcas: `F001`, `B001`, `FC01`, `BC01`. La marca queda registrada en cada comprobante. |
| Régimen del RUC 10 | Configurable; no bloquea nada por ahora. |
| PDF | Se decide en la fase 5. |

**Pendiente de confirmar en SUNAT beta (fase 4)** ⚠️

1. Código exacto para boletas sin cliente identificado ("clientes varios"). Hoy: tipo `0`.
2. Tolerancias de redondeo que acepta SUNAT (con nuestro método la diferencia máxima es S/ 0.01).
3. Catálogo 09 (motivos de nota de crédito) y demás catálogos contra la versión oficial vigente.
4. Plazos de envío y de baja, y el impacto de la R.S. 000048-2026 desde el 1-ene-2027.
5. Límite de líneas por resumen diario (hoy 500).

**Revisión de seguridad de la fase 2**

- Todas las consultas a la base usan parámetros (sin riesgo de inyección SQL).
- El XML escapa automáticamente los caracteres especiales (`&`, `<`, comillas).
- Se agregó el rechazo de caracteres de control invisibles, que habrían producido XML inválido.
- Se agregó un límite de 10 decimales en cantidades y precios: la base los habría redondeado
  sin avisar y lo guardado no habría coincidido con lo calculado.
- Se agregó un manejador de errores de conexión para que un corte de la base no tumbe el proceso.
- No hay claves, certificados ni contraseñas en el código. La única contraseña escrita es
  la de la base de pruebas local (`facturador`), que no sirve fuera de tu computadora.
- Las pruebas solo borran bases cuyo nombre termina en `_pruebas`, para no tocar la base real.
- Para las próximas fases: falta el aislamiento por empresa con *Row Level Security*
  (fase 6, junto con los roles de usuario y las llaves de API).

## 8. Fase 3 — Firma digital (resultado)

**Qué quedó hecho**

- Lectura del certificado `.pfx`: contraseña equivocada, archivo inválido, certificado
  vencido o aún no vigente → mensaje claro. Si el `.pfx` trae la cadena de certificados,
  se elige el que corresponde a la llave.
- Firma XMLDSig *enveloped* dentro de `ext:ExtensionContent`, con `Id="SignatureSP"`,
  C14N inclusiva y el certificado incluido (`X509Certificate`). Sirve para facturas,
  boletas, notas de crédito, resúmenes diarios y comunicaciones de baja.
- Cada firma se verifica antes de entregarse. En las pruebas, además, la revisa un
  **verificador independiente** (Python, otras librerías) y se valida otra vez contra
  el esquema UBL 2.1, ahora con la firma real.
- Certificado guardado **cifrado** (AES-256-GCM) con una llave maestra que solo está
  en variables de entorno. El cifrado queda atado a la empresa: copiarlo a otra no sirve.
- Firma única por comprobante: se guarda el XML firmado (sin sobrescribir), su huella
  SHA-256, el `DigestValue` (va en el PDF/QR), el certificado y el algoritmo usados.
  Si se pide firmar otra vez, devuelve el mismo XML; si alguien altera el archivo, se detecta.
- Comandos nuevos: `npm run llave:generar` y `npm run certificado:cargar`.
- 153 pruebas automáticas pasando.

**Error encontrado y corregido por las pruebas:** con 5 procesos firmando a la vez el
mismo comprobante, uno podía no ver la firma recién guardada por otro. El índice único
impedía la doble firma, pero ese proceso fallaba. Se corrigió consultando el archivo
después de tomar el bloqueo.

**Pendiente de confirmar en SUNAT beta (fase 4)** ⚠️

1. **Algoritmo:** Greenter (aceptado por SUNAT) usa RSA-SHA1. No pude confirmar en la
   documentación oficial si SUNAT acepta SHA-256. Es configurable (`FIRMA_ALGORITMO`);
   por defecto SHA1. En beta se probarán ambos.
2. Si SUNAT exige registrar el certificado en Operaciones en Línea (SOL) antes de usarlo.
3. Requisitos del certificado (por ejemplo, que el RUC figure en sus datos).

**Revisión de seguridad de la fase 3**

- La llave privada y la contraseña del `.pfx` solo existen en memoria al firmar; no se
  escriben en registros, auditoría ni mensajes de error. La contraseña se pide por
  teclado sin mostrarse.
- `node-forge` tiene un aviso de seguridad (GHSA-86w9-cpqp-85rv) sobre su
  *verificación* de firmas RSA. Solo lo usamos para abrir el `.pfx`; la firma y la
  verificación las hace el módulo `crypto` de Node.
- Cuando verificamos nuestros propios comprobantes exigimos NUESTRO certificado: una
  firma válida de otro certificado se rechaza.
- El almacén de archivos no sobrescribe y rechaza rutas como `../` o `/etc/...`.
- La base de datos impide cambiar una firma registrada, reactivar o borrar certificados,
  y tener dos XML firmados para el mismo comprobante.
- `.gitignore` bloquea `*.pfx`, `*.p12`, `*.pem`, `*.key`, `.env` y la carpeta `almacen/`.
- Para más adelante: rotación de la llave maestra (volver a cifrar con una nueva) y
  almacenamiento en la nube con bloqueo de objetos (fase 4).

## 9. Fase 4 — Envío a SUNAT beta (resultado)

**Qué quedó hecho**

- **Cliente de SUNAT** (`billService`, SOAP con usuario y clave): `sendBill`
  (facturas, boletas, notas), `sendSummary` y `getStatus` (resúmenes y bajas, con
  ticket). El formato sale del WSDL oficial. Empaqueta el XML en ZIP y lee la
  constancia (CDR): aceptado, aceptado con observaciones o rechazado.
- **Beta sin certificado ni Clave SOL:** usuario público `RUC + MODDATOS`.
  Producción usa el usuario SOL secundario, guardado cifrado, y además exige
  `SUNAT_PERMITIR_PRODUCCION=si` (doble candado).
- **Cola con reintentos automáticos:** si SUNAT no responde, el comprobante queda
  `PENDIENTE_ENVIO` y se reintenta solo (1, 2, 5, 10, 30, 60, 120 y luego cada 240
  minutos). **Nunca se descarta.** Avisa al 5.º intento y cuando se acerca el plazo legal.
- **Sin duplicados:** cada reintento envía exactamente el mismo XML firmado. Si SUNAT
  dice que ya lo tiene (1032, 1033), no se reenvía: queda para revisar. Dos procesadores
  a la vez nunca envían el mismo comprobante.
- **Errores en español:** se cargaron los **1710 códigos oficiales de SUNAT**, con
  explicación simple y "qué hacer" para los 32 más frecuentes. Ejemplo: *"Código 0111:
  El usuario SOL no tiene permiso para enviar comprobantes electrónicos. Qué hacer: en
  SOL, dale al usuario secundario los permisos de comprobantes de pago electrónicos."*
- **Anulaciones:** facturas por comunicación de baja y boletas por resumen diario
  (estado 3), con motivo, plazo configurable y consulta del ticket. Si SUNAT rechaza la
  anulación, el comprobante vuelve a quedar vigente y se avisa.
- **Alertas** (tabla `alertas`): rechazos, observaciones, SUNAT sin respuesta, plazo
  cercano y problemas de configuración.
- **SUNAT simulado** para las pruebas: acepta, observa, rechaza, falla, se cuelga o
  corta la conexión, y verifica la firma de lo que recibe.
- Comandos: `npm run sunat:beta` (prueba real en beta, ver `docs/PRUEBA_BETA.md`) y
  `npm run cola:procesar` (una vuelta de la cola, para el cron).
- **187 pruebas automáticas** pasando, estables en varias corridas seguidas.

**Prueba REAL en SUNAT beta: superada (23-oct-2026).** El dueño la ejecutó desde su
computadora con `npm run sunat:beta` (RUC de Corporación Agamenón + MODDATOS). SUNAT
respondió código 0 ("ha sido aceptada") en los 11 envíos:

| Comprobante | SHA1 | SHA256 |
|---|---|---|
| Boleta con DNI | ✅ | ✅ |
| Boleta sin cliente identificado (tipo de documento `0`) | ✅ | ✅ |
| Factura al contado | ✅ | ✅ |
| Factura al crédito (2 cuotas) | ✅ | ✅ |
| Nota de crédito de factura | ✅ | ✅ |
| Comunicación de baja (ticket + consulta) | ✅ | — |

Esto confirma:

- La estructura de nuestros XML y la firma digital.
- Que SUNAT acepta firmas **SHA-256**. Se recomienda usar `FIRMA_ALGORITMO=SHA256` en producción,
  más seguro que SHA1, y confirmarlo con el primer envío real.
- Que el tipo de documento `0` sirve para boletas sin cliente identificado.

Ojo: beta revisa la estructura, no si los datos existen. Por ejemplo, no comprueba que
el RUC del cliente esté activo. Producción puede tener validaciones adicionales.

**Pendiente para producción** ⚠️

- Consultar el estado de un comprobante en SUNAT (`billConsultService`, requiere el usuario
  SOL real). Sirve para resolver los casos "ya registrado" (1033) sin intervención manual.
- ~~Almacenamiento en la nube~~ ✅ resuelto: los archivos van en la base (ver sección 15).
- Confirmar los plazos en la norma (hoy configurables: factura 3 días, resumen 7, baja 7).
- El certificado debe estar registrado en SOL: si no, SUNAT responde 2325 *"El certificado
  usado no es el comunicado a SUNAT"*.

**Revisión de seguridad de la fase 4**

- **Corregido:** el procesador tomaba hasta 20 trabajos de golpe con un bloqueo de
  5 minutos. Si SUNAT tardaba, los últimos podían quedar con el bloqueo vencido y otro
  procesador los habría enviado de nuevo (duplicado). Ahora toma uno a la vez, cada uno
  con su propio bloqueo.
- La conexión a SUNAT verifica su certificado HTTPS. Greenter desactiva esa verificación;
  aquí no se desactiva.
- La clave SOL viaja solo en el mensaje a SUNAT. No se guarda en los registros de envíos
  ni en la auditoría, y en la base está cifrada y atada a la empresa.
- La dirección de SUNAT simulado (`SUNAT_URL_BETA`) solo puede reemplazar a beta, nunca a producción.
- Los nombres de tabla que se arman en el código vienen de una lista fija (sin riesgo de inyección SQL).
- Riesgo conocido y aceptado: si el proceso se cae justo después de que SUNAT aceptó y
  antes de guardar la respuesta, el reintento recibirá 1033. Queda para revisar, no se duplica.

## 10. Fase 5 — PDF con QR (resultado)

**Qué quedó hecho**

- Representación impresa de factura, boleta y nota de crédito en **dos formatos**:
  - **A4**, para enviar por WhatsApp o correo. Tiene tabla de productos, varias páginas si hace
    falta (repite el encabezado de la tabla) y logo opcional.
  - **Ticket de 80 mm** para impresora térmica: una sola tira, con el alto justo.
- **El formato se elige en cada pedido.** Si no se indica, se usa el **formato por defecto del
  canal** (columna `canales.formato_pdf`; por ejemplo, tienda web → A4 y venta en persona → ticket).
- Contenido: emisor, RUC, tipo y número, fecha, cliente (o "CLIENTES VARIOS"), moneda, forma
  de pago y cuotas, documento que modifica y motivo (notas de crédito), detalle, operaciones
  gravadas/exoneradas/inafectas, IGV, total, monto en letras, **código hash** de la firma,
  **QR** y la leyenda *"Representación impresa de la … Consulte su validez en www.sunat.gob.pe"*.
- QR: `RUC|TIPO|SERIE|NÚMERO|IGV|TOTAL|FECHA|TIPO DOC|NÚMERO DOC|` (mismo orden que Greenter). ⚠️
  Confirmar contra el anexo vigente de SUNAT.
- Protecciones: los PDF del ambiente **BETA** llevan la marca **"PRUEBA - SIN VALOR LEGAL"**, en
  diagonal y en horizontal. Los **anulados** llevan la marca "ANULADO". Un comprobante
  **rechazado** o **sin firmar** no se imprime.
- Ejemplos en `docs/ejemplos/*.pdf`.
- **212 pruebas automáticas** pasando. Las del PDF leen el texto con `pdftotext` y **escanean el
  QR desde la imagen** (`pdftoppm` + `jsQR`), como lo haría un celular.

**Revisión de seguridad de la fase 5**

- El PDF se arma desde los datos guardados y firmados. No se interpreta HTML ni código, así que no
  hay riesgo de inyección.
- El logo se lee del almacén con las mismas reglas de rutas (sin `../`). Si la imagen es inválida,
  se imprime sin logo y no se cae.
- La marca "SIN VALOR LEGAL" impide que un PDF de pruebas se haga pasar por un comprobante real.
- El QR solo contiene datos que ya figuran impresos en el comprobante.

## 11. Fase 6 — API y conexión con la tienda (resultado)

**Qué quedó hecho** (detalle en `docs/API.md`)

- **API HTTP** (Hono): emitir, consultar por id o por número de pedido, descargar PDF (A4 o
  ticket), XML y CDR, anular, endpoint de salud y endpoint del cron.
- **Llaves de API por canal**, guardadas solo como huella SHA-256 y comparadas en tiempo
  constante. Tienen permisos (`emitir`, `consultar`, `anular`), se revocan al instante y dejan
  de funcionar si se desactiva su canal.
- **Envío inmediato a SUNAT al emitir**, con un límite de 8 segundos. Si no alcanza, el
  comprobante queda en la cola y el cron lo reintenta.
- **Aislamiento por empresa:** cada consulta se limita a la empresa de la llave. Un comprobante
  de otra empresa responde 404.
- **Protecciones:** cuerpo de máximo 100 KB, límite de pedidos por minuto por llave, montos
  solo como texto y errores en español.
- **Comandos:** `empresa:configurar` (empresa, series, marca y 4 canales), `llave-api`
  (crear, listar, revocar), `sol:configurar` (usuario SOL secundario cifrado para
  producción) y `servidor`.
- **Conexión con la tienda:** dos formas documentadas con código listo, desde la tienda en
  Vercel o desde la hoja "Pedidos ED" con Apps Script. En ambas se emite **solo cuando
  confirmas el pago Yape/Plin**. No modifiqué el repositorio de la tienda: está fuera de
  este proyecto y conectarlo es una decisión tuya.
- **Guía para desarrolladores:** `docs/DESARROLLO.md`.
- **235 pruebas** pasando, más `npm run analizar` (TypeScript estricto + knip) sin observaciones.

**Errores encontrados y corregidos en esta fase**

- El control de acceso se registraba dos veces por pedido (la ruta `/v1/comprobantes/*`
  también cubre `/v1/comprobantes`). Duplicaba las consultas a la base y el conteo del límite
  por minuto.
- El análisis con knip encontró la función `guardarCredencialesSol` sin usar: faltaba el
  comando para cargar el usuario SOL de producción. Se agregó `sol:configurar`, con su prueba.
- Se quitó código duplicado: la configuración de variables de entorno (ahora solo en
  `src/config.ts`) y la creación de empresas de prueba (ahora usa `configurarEmpresa`, la misma
  función de producción).

**Revisión de seguridad de la fase 6**

- Las llaves nunca se guardan completas, y la comparación no revela información por tiempos.
- Un 401 no explica por qué la llave falló (inexistente, revocada o canal desactivado), para
  no dar pistas.
- El endpoint del cron tiene su propia clave (`CLAVE_CRON`). Sin ella configurada, queda cerrado.
- Los errores internos no exponen detalles al cliente; solo se registran en el servidor.
- **Pendiente para producción:** *Row Level Security* en PostgreSQL como segunda barrera (hoy
  el aislamiento lo hace la aplicación y está probado). (El almacenamiento quedó resuelto en la
  sección 15 y los enlaces del PDF para el cliente en la 18.)

## 12. Fase 7 — Cobros y estado de pago (resultado)

- **Pagos** por comprobante con medio (Yape, Plin, efectivo, transferencia, tarjeta, pasarela),
  fecha y **número de operación**. La misma operación no se registra dos veces, ni siquiera si
  llega dos veces a la vez.
- **Saldo** = total − pagos vigentes − notas de crédito vigentes. **Estado de pago** PENDIENTE,
  PARCIAL o PAGADO, calculado siempre; nunca se edita a mano. No se puede pagar más que el saldo,
  aunque lleguen varios pagos al mismo tiempo (probado con 5 pagos simultáneos).
- **Cuotas:** los pagos cubren las cuotas en orden de vencimiento. Alertas **AMARILLAS** cuando una
  cuota vence en 3 días o menos y **ROJAS** cuando ya venció, revisadas en cada vuelta del cron.
- **Anular un pago** mal registrado: queda en el historial con su motivo y el saldo se recalcula.
- **Resumen del día:** ventas por tipo, notas de crédito, cobros por medio de pago, saldo por
  cobrar, cuotas vencidas, pendientes con SUNAT y alertas abiertas.
- **API:** `POST /v1/comprobantes/{id}/pagos`, `GET /v1/reportes/resumen-dia`, saldo y pagos en
  cada comprobante. La tienda puede **emitir y registrar el Yape en una sola llamada**.
- **Pendiente:** consulta automática del estado en SUNAT (`billConsultService`). Requiere el usuario
  SOL real y no se puede probar en beta. Hoy los rechazos ya se detectan y avisan al enviar.
- 246 pruebas pasando y `npm run analizar` limpio.

**Error de diseño corregido:** el control de acceso ahora se registra una sola vez para todo
`/v1/*`. Una ruta inexistente sin llave responde 401, así no se revela qué rutas existen.

## 13. Fase 8 — Inventario, compras y margen (resultado)

- **Productos por SKU** (`npm run inventario -- producto …`). El stock es la suma de movimientos;
  los muebles a pedido pueden marcarse `--sin-stock`.
- **Ventas:** cada ítem con código (SKU) se enlaza a su producto, guarda el costo del momento y
  descuenta stock. **Vender sin stock no se bloquea** (puede ser a pedido): se avisa con alerta
  **AMARILLA** al llegar al mínimo y **ROJA** si queda negativo. La alerta se cierra sola al reponer.
- **Notas de crédito por devolución** (motivos 06 y 07) devuelven el stock; un descuento no.
  **Anulación aceptada por SUNAT** agrega el movimiento contrario (nada se borra).
- **Compras a proveedores** desde un JSON con los montos de la factura: se verifica que cuadren,
  no se registra dos veces la misma factura, suma stock y recalcula el **costo promedio ponderado**.
  La validación en SUNAT de la factura y del proveedor (habido) queda para el módulo de crédito
  fiscal (`estado_validacion = PENDIENTE`).
- **Margen semanal** (lunes a domingo, **estimado**, sin IGV): ventas − costo, con la **meta**
  configurable (`npm run reporte -- meta --monto 3000`) y su % de cumplimiento. Los ítems sin
  costo conocido se muestran aparte y no inflan el margen. Los costos **no** salen por la API.
- **Historial de cliente** por DNI/RUC: comprobantes, total comprado y saldo por cobrar. Los
  clientes se registran solos al emitir con documento.
- **Mejoras de paso:** una alerta abierta se actualiza (antes quedaba con el primer mensaje);
  el cálculo del saldo y la búsqueda de empresa por RUC quedaron en un solo lugar.
- 256 pruebas pasando y `npm run analizar` limpio.

## 14. Descuento global (preparación para conectar la tienda)

- La tienda cobra con cupones y ofertas automáticas. El comprobante debe decir **exactamente** lo
  cobrado, así que la API acepta `descuento` (con IGV) y lo emite como **descuento global que
  afecta la base imponible** (catálogo 53, código `02`).
- Cálculo: total gravado con IGV − descuento = lo cobrado; de ahí se separan base neta e IGV con
  el mismo criterio de los ítems. En el XML: `cac:AllowanceCharge` (02, monto sin IGV, base bruta,
  factor solo si reproduce el monto), base gravada e IGV netos, `LineExtensionAmount` neto y sin
  `AllowanceTotalAmount` (ese es para descuentos que NO afectan la base).
- Fuentes (consultadas el 23/10/2026; el portal de SUNAT no es accesible desde este entorno):
  reglas 2519, 3226, 3277 y 3291 del listado de códigos de error de SUNAT
  (`db/datos/sunat-codigos-error.xml`), la plantilla UBL 2.1 de Greenter
  (`github.com/thegreenter/greenter`) y la implementación de khipu homologada en SUNAT beta
  (`github.com/bacsystem/khipu`, prueba `descuentoGlobalQueAfectaLaBase_codigo02`).
- ✅ **Confirmado en SUNAT beta (23/10/2026):** "La Factura numero F001-2791763, ha sido aceptada"
  y "La Boleta numero B001-2791773, ha sido aceptada", ambas con descuento global. En esa corrida,
  SUNAT beta respondió HTTP 401 con una página HTML al azar a varios envíos (incluso a casos ya
  aceptados antes): es una falla del servidor de pruebas. El facturador ahora lo explica con un
  mensaje claro y lo reintenta solo.
- Las notas de crédito no llevan descuento global: se emiten con los montos ya rebajados.
- El margen semanal resta los descuentos. 265 pruebas pasando y `npm run analizar` limpio.

## 15. Listo para publicar (resultado)

- **Archivos en la base de datos** (`AlmacenPostgres`, migración 011): XML firmados, constancias
  y logos se guardan en la tabla `archivos_contenido`, solo inserción (ni el SQL directo puede
  editarlos o borrarlos). Son pocos KB por comprobante y así el respaldo de la base los incluye.
  `ALMACEN_DIR` (carpeta) queda solo para desarrollo.
- **Conexión cifrada y verificada** a la base con `DATABASE_CA_CERT` (certificado de Supabase).
- **Render** (`render.yaml`): arranca aplicando las migraciones pendientes y revisa `/v1/salud`.
- **GitHub Actions:** `pruebas` (todas las pruebas con PostgreSQL real en cada subida), `cola`
  (cada 5 min) y `respaldo` (diario, cifrado, 90 días; descargar uno al mes para los 5 años).
- Los comandos de consola leen `.env` solos.
- Guía para el dueño: `docs/PUBLICAR.md`. Publicar sigue siendo BETA; producción, aparte.

## 16. Devoluciones (resultado)

- **Un paso:** `npm run devolucion -- --comprobante B001-15 --items 1:1 --motivo "…" [--danados 1]
  [--reembolso YAPE]` emite la nota de crédito, devuelve el stock y registra el reembolso.
- **Motivo automático:** `06` (devolución total) si vuelve todo de una vez, `07` (por ítem) si no.
- **Con descuento global** se devuelve lo que el cliente pagó, no el precio de lista; una
  devolución total devuelve exactamente el importe del comprobante.
- **Nunca más de lo vendido:** se descuenta lo ya devuelto, con un candado por comprobante
  (probado con dos devoluciones simultáneas). Solo sobre comprobantes aceptados por SUNAT.
- **Producto dañado:** la nota se emite igual, pero no regresa al stock vendible (ajuste con motivo).
- **Reintentar es seguro:** cada devolución lleva su clave; un corte no emite dos notas.
- **Error corregido (de la fase 8):** si SUNAT rechazaba una venta, su stock quedaba descontado.
  Ahora todo comprobante rechazado o anulado revierte su stock, una sola vez, en un solo lugar.
- Pendiente para cuando la tienda lo necesite: devoluciones desde la API y el panel de la tienda.
- 280 pruebas pasando y `npm run analizar` limpio.

## 17. Revisión de seguridad completa (resultado)

Detalle en `docs/SEGURIDAD.md`. Corregido: límite de intentos fallidos por dirección (frena sin
tocar la base), limpieza del contador de pedidos por minuto, cabeceras de seguridad y límite a lo
que se descomprime de las respuestas de SUNAT. Pendientes con motivo: `node-forge` sin parche (no
afecta cómo se usa), RLS, usuario de base con permisos mínimos y panel con dos pasos.

## 18. El cliente recibe su comprobante (resultado)

- Cada comprobante trae `enlaces.cliente`: abre el PDF **sin llave de API**, para entregárselo al
  cliente (seguimiento del pedido en la tienda, WhatsApp). Es un enlace firmado con HMAC-SHA256
  (clave derivada de la `LLAVE_MAESTRA`): no se puede alterar para ver otro comprobante ni alargar
  su vigencia (1 año). Los intentos con enlaces falsos cuentan para el límite de intentos.
- Probado: enlace válido, alterado, de otro comprobante, vencido, y la dirección pública https
  detrás de Render.

## 20. Panel web para emitir a mano (resultado, pendiente de tu aprobación)

Para ventas por WhatsApp, Instagram o en persona, sin pasar por la tienda. Vive en el mismo
servidor: `<dirección del facturador>/panel`. Pensado para el celular.

- **Entrar:** correo + contraseña + código de 6 dígitos de Google/Microsoft Authenticator.
  Los usuarios se crean desde la laptop: `npm run usuario -- crear …` (muestra el QR).
- **Emitir:** tipo, canal (WhatsApp, Instagram, Presencial), cliente, productos con precio con
  IGV y, si ya pagó, medio y nº de operación. Usa el mismo camino que la API: mismas
  validaciones, mismo correlativo, envío inmediato a SUNAT y cola si no responde. Pulsar
  dos veces no emite dos (cada formulario lleva su propio número interno).
- **Después de emitir:** PDF A4, ticket, enviar el enlace al cliente por WhatsApp o copiarlo.
- **Lista** de los últimos 30 comprobantes de la empresa con su estado en SUNAT.
- **Varias empresas:** un usuario con acceso a dos RUC cambia entre ellos.
- **Roles:** DUEÑO, ADMIN y VENDEDOR emiten; CONTADOR y SOLO_LECTURA solo consultan.
- Seguridad: ver `docs/SEGURIDAD.md`, sección "Panel web".
- Probado: 13 pruebas de punta a punta (entrar, bloqueo, código reusado, CSRF, roles,
  aislamiento entre empresas, doble clic) + prueba en navegador real (Chromium, tamaño celular).

**Agregado después (27/10/2026):**
- **Tablero** al entrar:
  - próximo **vencimiento de la declaración y pago mensual** (IGV y Renta) con los días que
    quedan, según el último dígito del RUC y el **cronograma oficial 2026** (Anexo I de la
    R.S. 281-2022/SUNAT, transcrito de sunat.gob.pe el 27/10/2026, migración 015; cada año se
    agrega el nuevo). Buen contribuyente usa su columna;
  - **resumen del mes** que se va a declarar: ventas, IGV cobrado, IGV de compras, IGV estimado
    a pagar o saldo a favor, y pago a cuenta de Renta MYPE estimado (su tasa sigue "POR VERIFICAR");
  - certificado por vencer, comprobantes en cola o rechazados y saldo por cobrar.
- **Devolución total** (nota de crédito, el stock vuelve) y **anulación** desde el panel, solo
  para dueño o administrador.
- **Productos guardados** al emitir (el precio se completa solo) y **cliente conocido** por su
  DNI/RUC.
- **Exportar** las ventas del mes a Excel (CSV), para el contador.
- **Cambiar la contraseña** (exige la actual y un código nuevo; cierra las otras sesiones).
- **Pestañas** Vender · Cobrar · Compras · Stock · Más:
  - **Compras** de proveedores (dueño, administrador o contador): su IGV se descuenta del IGV
    estimado del mes; con producto, suma al stock. El IGV se sugiere con la tasa vigente de la base.
  - **Venta al crédito con cuotas** (solo facturas) y **cobros** de saldos (mismo nº de operación
    no se registra dos veces).
  - **Stock**: ver, crear productos y ajustar con motivo (dueño o administrador).
- **Avisos por correo** (Resend, gratis; apagado sin `RESEND_API_KEY`): vencimiento de la
  declaración (7, 3 y 0 días), certificado (60, 30 y 7 días) y alertas rojas. Salen una sola
  vez cada uno (`avisos_enviados`, migración 017) y se reintentan si el envío falla.
- **Para venderlo como producto** (pestaña "Más"):
  - **Usuarios**: el DUEÑO da acceso a vendedores, administradores o su contador; si el correo
    es nuevo, el panel muestra el QR para el celular de esa persona y se activa con su código.
  - **Certificado digital** (.pfx/.p12): lo carga o renueva el DUEÑO; se guarda cifrado.
  - **Logo** de la empresa en el PDF (se achica en el navegador; solo PNG/JPG reales, 70 KB).
  - **Primera configuración sin la PC**: con la llave de la tienda (o `CLAVE_INSTALACION` en
    Render) se crea el primer usuario (dueño y administrador de la plataforma) desde el celular; se cierra para siempre en
    cuanto existe un usuario.
  - **Mantener la sesión iniciada** 30 días en un dispositivo propio (casilla al entrar) y
    **cerrar sesión en los demás dispositivos** (pestaña Más).
  - **Recuperar el acceso** sin entrar a Render: códigos de respaldo (celular perdido), enlace por
    correo (contraseña olvidada) y, si se perdió todo, la llave de la tienda (solo el dueño).
    En la PC: `npm run usuario -- recuperar`.
  - **Alta de empresas nuevas**: solo el administrador de la plataforma
    (`npm run usuario -- plataforma --email …`); nunca pisa una empresa que ya existe.
- **Estadísticas de ventas** (función "estadisticas", solo dueño, administrador y contador): ventas de
  hoy y del mes (contra los mismos días del mes anterior), ticket promedio, clientes y nuevos,
  gráficos de 6 meses (con compras) y 30 días, ventas por canal y lo más vendido. Todo calculado en
  el servidor con decimales exactos; el navegador solo dibuja.
- **Reposición e inventario** (pestaña Stock; dueño, administrador y contador): colchón (stock de
  seguridad), tiempo de entrega por proveedor o por producto, venta diaria de los últimos 30 días,
  días que alcanza, punto de pedido, cantidad sugerida, valor del inventario, días de inventario,
  productos sin movimiento y **Kardex** valorizado a costo promedio ponderado (descargable a Excel;
  control interno: el formato oficial del registro de inventario lo revisa el contador).
- **Caja y cuentas de cobro** (pestaña Cobrar; dueño, administrador y contador): cuentas donde entra el
  dinero (Yape de la empresa, Yape de otra persona, efectivo, banco…), cada cobro dice a cuál entró,
  y la caja muestra cada cuenta, lo de la empresa, lo de terceros y el total (hoy, 7 días, mes). La
  venta es de la empresa igual: lleva su comprobante y se declara; aquí solo se ve dónde quedó el dinero.
- **Cierre de caja diario** (misma pestaña): por cada cuenta, lo que debería haber según los cobros
  (lo calcula el facturador) contra lo contado; guarda la diferencia, quién cerró y una nota. No se
  cambia ni se borra: si se contó mal, se cierra de nuevo y vale el último. Historial de 30 días.
- **Venta rápida** (pestaña Vender): botones con lo más vendido en los últimos 60 días (sale de los
  comprobantes, funciona sin catálogo). Un toque agrega el producto; si no se escribió documento, la
  boleta va sin documento (el facturador exige el DNI si se pasa el límite vigente).
- **Clientes frecuentes y WhatsApp** (pestaña Cobrar): los que más compran en el último año (veces,
  total, última compra, lo que deben). Se guarda su celular (validado, con código de país) y se abre
  WhatsApp con el mensaje ya escrito: recordar un cobro o saludar. Nunca se envía solo: la persona lo
  revisa y lo manda. El celular es dato personal (Ley 29733): solo para atender al cliente.
- **App instalable (PWA)**: manifiesto, íconos y service worker (solo guarda la página, nunca los datos);
  aviso "Hay una versión nueva · Actualizar". **Escáner** de códigos de barras (lector USB/Bluetooth o
  cámara con BarcodeDetector) y código de barras por producto. **Reportes** de los usuarios al
  administrador de la plataforma.
- **Cada empresa elige qué funciones usa** (`npm run empresa:modulos`): panel, vencimientos,
  resumen, certificado, cobros, notas, productos, exportar, compras, avisos, estadisticas. Sin "panel", la empresa ni aparece
  en el panel y sigue solo por API.

## 19. Decisiones que siguen abiertas

Mientras no respondas, se usan las decisiones provisionales de la sección 7.


1. **Base de datos:** ¿Neon o Supabase? (recomiendo **Supabase**: incluye `pg_cron`
   para la cola y almacenamiento de archivos en el mismo lugar).
2. **Boletas:** ¿envío una por una (recomendado: CDR inmediato) o resumen diario?
   Las anulaciones de boletas igual irán por resumen diario.
3. **Series:** propuesta `B001` (boletas), `F001` (facturas), `BC01`/`FC01`
   (notas de crédito de boleta/factura). ¿Una serie por marca o compartidas?
4. **Régimen del RUC 10** (taxi): ¿Nuevo RUS, RER, MYPE o General?
