# Revisión de seguridad

Revisión completa antes de publicar el facturador (23/10/2026). Se repite al cerrar cada fase.

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
| Recuperar sin nada (dueño) | Con una llave de API vigente (`fk_…`) de una empresa donde ese usuario es DUEÑO, o con `CLAVE_RECUPERACION` en Render; en tiempo constante y con límite de intentos. Contraseña y segundo paso nuevos (inactivo hasta confirmar el código), cierra todas las sesiones, avisa por correo y queda en `auditoria`. Quien tiene esa llave ya puede emitir a nombre de la empresa. |
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
