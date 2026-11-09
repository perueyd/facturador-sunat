# Revisión de seguridad

Revisión completa antes de publicar el facturador (23/10/2026). Se repite al cerrar cada fase
(última: 07/11/2026).

## Lo que se revisó y está bien

| Tema | Cómo está protegido |
|---|---|
| Llaves de API | Una por canal, guardadas solo como huella SHA-256, comparadas en tiempo constante, revocables. Permisos por llave (`emitir`, `consultar`, `cobrar`, `anular`). |
| Datos de otra empresa | Toda consulta filtra por la empresa de la llave; un id ajeno responde 404 (probado). |
| Certificado y Clave SOL | Cifrados con AES-256-GCM y la `LLAVE_MAESTRA` (variable de entorno); nunca en la base en claro ni en GitHub. |
| Producción SUNAT | Doble candado: autorización registrada del dueño + `SUNAT_PERMITIR_PRODUCCION=si`. |
| Comprobantes, pagos, stock, archivos | Solo inserción o inmutables por disparadores en la base: ni con SQL directo se editan o borran. |
| Inyección SQL | Todas las consultas usan parámetros (`$1`, `$2`…). |
| Pedidos gigantes | Límite de 100 KB por pedido y de 120 pedidos por minuto por llave. |
| Errores | Al cliente nunca se le muestran detalles internos; solo se registran en el servidor (sin claves). |
| XML de SUNAT | El lector no resuelve entidades externas (sin XXE). |
| Repositorio | Sin certificados, claves ni `.env` (revisado con búsqueda de patrones). |

## Corregido en esta revisión

1. **Límite de intentos fallidos.** Antes se podían probar llaves sin fin y cada intento consultaba
   la base. Ahora, tras 20 intentos fallidos en un minuto desde una dirección, esa dirección
   queda frenada un minuto (429) **sin tocar la base**, incluso si después acierta la llave.
   También aplica a la clave del cron.
2. **Tabla del límite sin fin.** El contador de pedidos por minuto nunca se limpiaba; ahora sí.
3. **Cabeceras de seguridad** en todas las respuestas (`nosniff`, `SAMEORIGIN`, etc.).
4. **Bomba ZIP.** Las respuestas de SUNAT solo se descomprimen si son XML de hasta 5 MB.
5. **Conexión a la base** cifrada y verificada con el certificado de Supabase (`DATABASE_CA_CERT`).
6. **Respaldos** cifrados (AES-256) antes de salir hacia GitHub.

## Auditoría del 02/11/2026

Revisado otra vez, con todo lo agregado después (caja, gastos, cotizaciones, cuentas por pagar,
plataforma): dependencias sin vulnerabilidades, historial de Git sin claves, sin `innerHTML` en el
panel (no se puede inyectar código con datos de clientes), consultas con parámetros, montos solo
con decimales exactos, tasas y límites en la base, correlativos con bloqueo de fila, idempotencia
con índice único, XML y CDR guardados 6 años, contraseñas con scrypt, segundo paso que no acepta
un código dos veces, sesiones que se cierran al restablecer el acceso, enlaces de PDF firmados y con
vencimiento, CSV a prueba de fórmulas, producción con doble candado.

Corregido:

1. **Anulación por la API sin autor.** La auditoría no guardaba qué llave (qué canal) pidió la
   anulación; ahora sí. Además, la anulación revisa por sí misma que el comprobante sea de la
   empresa que la pide (antes lo revisaba solo la ruta).

Sigue pendiente lo de la tabla de abajo (RLS y usuario de base con permisos mínimos).

## Revisión del 07/11/2026

Todo lo agregado desde el 02/11: comprobantes subidos de SUNAT (XML/ZIP), ventas sin internet,
padrón de SUNAT, productos desde Excel, conexiones (llaves de API), "ya declaré", devoluciones con
reembolso, cierre de caja y la prueba de carga.

Revisado y bien:

| Tema | Resultado |
|---|---|
| Una empresa viendo datos de otra | Prueba nueva `tests/db/aislamiento-nuevo.test.ts`: el dueño de otra empresa no puede ver ni tocar comprobantes subidos, ventas sin internet, su archivo para SUNAT, llaves, declaraciones ni sugerencias. |
| Permisos por rol | Subir comprobantes, importar productos y devolver: dueño o administrador. Archivo para SUNAT y "ya declaré": dueño, administrador o contador. Desconectar sistemas y prender funciones: solo el dueño. Cada uno con su prueba. |
| XML subidos | El lector no expande entidades de ningún tipo (probado: ni externas —sin XXE— ni internas —sin "billion laughs"—). |
| Inyección en pantalla | El panel no usa `innerHTML`: nombres de archivos, clientes y productos se muestran como texto. |
| Excel exportado | Los nombres importados pasan por el filtro anti-fórmulas de los CSV (`csvParaExcel`). |
| Llaves de API | El panel muestra solo el prefijo público; el secreto nunca sale (probado). Desconectar es inmediato (401). |
| Padrón de SUNAT | Datos públicos de SUNAT; se carga con consultas con parámetros y un archivo cortado no borra el padrón. |
| Dependencias | `npm audit`: 0 vulnerabilidades; `hono`, `node-forge` y otras actualizadas (07/11). |
| Historial de Git | Sin llaves, claves ni certificados desde el 02/11 (búsqueda de patrones). |

Corregido:

1. **Cuelgue con muchos envíos a la vez** (prueba de carga, 05/11): el XML firmado y la constancia
   se guardaban con una segunda conexión teniendo una transacción abierta. Ahora las pruebas fallan
   si alguien pide otra conexión dentro de una transacción (`exigirFueraDeTransaccion`).
2. **Devoluciones**: el candado ocupaba una conexión del grupo; ahora usa una propia (07/11).
3. **ZIP que miente sobre su tamaño** (comprobantes subidos): se descomprimía entero antes de
   descartarlo y dejaba al servidor ocupado. Ahora se abre en pedazos y se corta al pasar 1 MB.
4. **"Traer de mi tienda"** se quitó (el dueño quiere tienda y facturador independientes); con eso
   desaparece la única función que hacía que el servidor descargara una dirección dada por el usuario.

A tener en cuenta (no son fallas, pero conviene saberlo):

- **Firma de los comprobantes subidos**: "firma válida" significa que el XML no se modificó después de
  firmarse con el certificado que trae adentro; no comprueba que ese certificado sea de SUNAT. Quien
  sube los XML es el dueño o un administrador de la propia empresa.
- **Ventas sin internet en el celular**: mientras no se envían, quedan en el navegador del aparato
  (incluido el DNI y nombre del cliente). Al salir del panel se borran los datos de la empresa, pero
  las ventas pendientes se conservan para no perderlas. No usar un celular compartido para vender sin
  internet, y no borrar los datos del navegador con ventas pendientes.

## Revisión del 09/11/2026: conectar páginas web desde el panel

Nuevo: el dueño crea la llave de una página (la de un cliente, una tienda nueva) en **Más →
Conexiones con páginas web**. La llave sale UNA vez; en la base queda su huella; permisos `emitir`,
`consultar` y `cobrar` (nunca `anular`); una llave activa por página, máximo 10 a la vez; un candado
evita dos llaves por doble clic (probado: sin el candado, el segundo clic daba error 500).

Corregido:

1. **Una llave de API servía para tomar la cuenta del dueño.** Con la llave de cualquier empresa
   y el correo de un DUEÑO de esa empresa se le podía poner contraseña y segundo paso nuevos. Las
   llaves se entregan al programador de cada página, y quien da de alta empresas de clientes es
   dueño de todas ellas: el programador de un cliente (o el propio cliente) podía quedarse con la
   cuenta del administrador y todas sus empresas. Ahora recuperar sin nada exige `CLAVE_RECUPERACION`
   de Render; la llave no sirve (prueba en `tests/db/recuperacion.test.ts`). La primera configuración
   por web (solo con la base sin ningún usuario) sigue aceptando la llave: ya está cerrada para siempre.

## Panel web (`/panel`)

| Tema | Cómo está protegido |
|---|---|
| Entrar | Correo + contraseña (scrypt, mínimo 10 caracteres) + código de 6 dígitos (TOTP). Sin el segundo paso activado no se entra. |
| Fuerza bruta | 5 fallos seguidos bloquean la cuenta 15 minutos; además, el límite de intentos por dirección de la API. Mismo mensaje para cualquier fallo y mismo tiempo de respuesta aunque el correo no exista. |
| Código reusado | Cada código de 6 dígitos sirve una sola vez (se guarda el último paso aceptado, de forma atómica). |
| Sesión | Token aleatorio de 256 bits en cookie `__Host-` HttpOnly, Secure, SameSite=Strict; vence a las 12 h, o a los 30 días si se marca "Mantener mi sesión iniciada" (solo en dispositivos propios). "Cerrar sesión en los demás dispositivos" corta todas menos la actual. En la base solo su huella SHA-256. Salir, desactivar el usuario o restablecer su 2FA la cortan al instante. |
| Otro sitio dando órdenes (CSRF) | Toda orden exige la cabecera `X-Panel: 1` y, si llega `Origin`, que sea el mismo sitio. |
| Código malicioso en la página (XSS) | Política de contenido estricta (solo el JavaScript propio) y todo dato se pinta como texto, nunca como HTML. |
| Roles y empresas | Cada usuario solo ve las empresas asignadas. DUEÑO, ADMIN y VENDEDOR emiten; CONTADOR y SOLO_LECTURA consultan. Comprobante de otra empresa → 404. |
| Secreto del 2FA | Cifrado con AES-256-GCM y la `LLAVE_MAESTRA`, ligado al usuario. |
| Historial | Entradas, fallos, bloqueos, cambios de contraseña y cada emisión quedan en `auditoria` con el usuario. |
| Notas de crédito y anulaciones | Solo DUEÑO o ADMIN, y solo si la empresa tiene activa la función "notas". |
| Exportar a Excel | Las celdas que empiezan con `=`, `+`, `-` o `@` se neutralizan (un nombre de cliente no puede convertirse en fórmula). |
| Funciones por empresa | Una función desactivada responde 403 aunque se llame directo a la API del panel. |
| Usuarios desde el panel | Solo el DUEÑO da acceso (nunca rol DUEÑO); el usuario nuevo no entra hasta activar su segundo paso con un código de SU app. |
| Certificado por el panel | Solo el DUEÑO; viaja por HTTPS y se guarda cifrado como siempre; cada contraseña equivocada cuenta como intento fallido. |
| Logo | Se valida por contenido (firma PNG/JPEG), no por el nombre; máximo 70 KB; los anteriores se conservan. |
| Alta de empresas | Solo usuarios marcados como administrador de la plataforma (por comando, en la PC); un RUC existente responde 409. |
| Códigos de respaldo | 10 por usuario, ~50 bits cada uno, de un solo uso; en la base solo su huella SHA-256 (con el id del usuario). Se gastan en la misma orden que los comprueba (dos entradas a la vez no los usan dos veces) y solo después de verificar la contraseña. Generar nuevos exige un código del momento y anula los anteriores. |
| Recuperar por correo | Responde igual exista o no el correo (y sin esperar el envío). Enlace de 32 bytes aleatorios, solo su huella en la base, vale 30 minutos y una vez; máximo uno cada 2 minutos por usuario y límite por dirección. El token va después de `#` (no llega a servidores ni a registros). Pide además el código de la app o uno de respaldo: robar el correo no basta. Cierra todas las sesiones y avisa por correo. |
| Recuperar sin nada | Solo con `CLAVE_RECUPERACION` en Render (mín. 16 caracteres; la tiene solo quien administra el facturador); en tiempo constante y con límite de intentos. Contraseña y segundo paso nuevos (inactivo hasta confirmar el código), cierra todas las sesiones, avisa por correo y queda en `auditoria`. Una llave de API (`fk_…`) **ya no sirve** para esto (ver revisión del 09/11/2026). |
| Primera configuración por web | Solo mientras la base no tenga NINGÚN usuario (con bloqueo para que dos pestañas no creen dos). Exige una llave de API vigente de ESA empresa (la de la tienda) o `CLAVE_INSTALACION` en Render (mín. 16 caracteres), con límite de intentos. Activar exige la prueba otra vez y que ese sea el único usuario, aún sin 2FA. Después se cierra para siempre. |
| Avisos por correo | Solo a DUEÑO y ADMIN activos; cada aviso una sola vez; la clave del proveedor solo en variables de entorno. |

## Protección automática (funciona sola)

| Qué | Cómo |
|---|---|
| SUNAT no responde | El comprobante queda en cola y se reintenta solo (cron cada 5 min). Nunca se pierde. |
| El mismo pedido llega dos veces | Se devuelve el comprobante ya emitido; nunca se emite dos veces. |
| Errores del servidor, cola atascada, rechazos, certificados o planes por vencer, base llena | La vigilancia avisa por correo una vez (`docs/PLATAFORMA.md`). |
| Librerías con fallas de seguridad | Dependabot abre un PR cada semana con el arreglo; las pruebas lo validan antes de unirlo. `npm audit` frena cualquier cambio con una falla grave conocida. |
| Algo que se rompe sin tocar el código | Las pruebas completas corren solas cada lunes, además de en cada cambio. |
| Una empresa viendo datos de otra | Prueba de "espía" (`tests/db/aislamiento.test.ts`): el dueño de una empresa intenta leer y cambiar, ruta por ruta, comprobantes, cotizaciones, gastos y fotos, compras, pagos, cuentas y usuarios de otra; todo debe rechazarse y los datos quedar intactos. Corre en cada cambio. |
| Fechas imposibles (ej. 30 de febrero) | Se rechazan con un mensaje claro antes de llegar a la base (`esFecha`). |
| Pérdida de datos | Respaldo diario cifrado (`respaldo.yml`); los comprobantes, pagos, cierres y la auditoría no se pueden borrar ni cambiar. |

`node-forge` (aviso GHSA-86w9-cpqp-85rv): corregido al actualizar a 1.4.2 (29/10/2026).

## Pendiente (con motivo)

| Pendiente | Por qué todavía no | Cuándo |
|---|---|---|
| *Row Level Security* en PostgreSQL | Hoy el aislamiento lo hace la aplicación y lo vigila la prueba de "espía". RLS sería una segunda barrera en la base, pero exige: un usuario de base sin permiso de saltarse RLS, que cada pedido corra en una transacción con la empresa fijada (`SET LOCAL`), y un camino aparte para la cola de SUNAT, que trabaja con todas las empresas. Es un cambio grande que hay que probar contra Supabase real. | Antes de vender el servicio a otros negocios, junto con el usuario de base de permisos mínimos. |
| Usuario de base con permisos mínimos | Supabase entrega un usuario con todos los permisos; un usuario sin `TRUNCATE` ni permiso para quitar disparadores reduce el daño si se filtra la conexión. | Al pasar a producción. |
| Repositorio público | No contiene secretos y los respaldos van cifrados. Se mantiene público porque así GitHub Actions (cola cada 5 min) es gratis. | Hacerlo privado si se pasa a un servidor que no se duerma y la cola se mueve fuera de GitHub. |
