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
| Sesión | Token aleatorio de 256 bits en cookie `__Host-` HttpOnly, Secure, SameSite=Strict; vence a las 12 h. En la base solo su huella SHA-256. Salir, desactivar el usuario o restablecer su 2FA la cortan al instante. |
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
| Avisos por correo | Solo a DUEÑO y ADMIN activos; cada aviso una sola vez; la clave del proveedor solo en variables de entorno. |

## Pendiente (con motivo)

| Pendiente | Por qué todavía no | Cuándo |
|---|---|---|
| `node-forge` (aviso GHSA-86w9-cpqp-85rv, sin parche) | El fallo está en *verificar* firmas RSA; aquí solo se usa para *abrir* el `.pfx`. Node no trae lector de PKCS#12. | Reemplazar si aparece una alternativa mantenida o el parche. |
| *Row Level Security* en PostgreSQL | Hoy el aislamiento lo hace la aplicación (probado). RLS sería una segunda barrera. | Antes de vender el servicio a otros negocios. |
| Usuario de base con permisos mínimos | Supabase entrega un usuario con todos los permisos; un usuario sin `TRUNCATE` ni permiso para quitar disparadores reduce el daño si se filtra la conexión. | Al pasar a producción. |
| Repositorio público | No contiene secretos y los respaldos van cifrados. Se mantiene público porque así GitHub Actions (cola cada 5 min) es gratis. | Hacerlo privado si se pasa a un servidor que no se duerma y la cola se mueve fuera de GitHub. |
