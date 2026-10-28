# Publicar el facturador en internet

Guía para el dueño, paso a paso. Al terminar, la tienda podrá pedir boletas y facturas
al facturador. **Todo sigue en ambiente BETA de SUNAT** (comprobantes de prueba, sin valor
legal): publicar el servidor NO es pasar a producción. Eso se hace aparte, con tu
autorización escrita y la lista de `docs/PLAN.md` (sección 6).

| Pieza | Servicio | Costo aproximado |
|---|---|---|
| Base de datos (comprobantes, XML, constancias) | Supabase | Gratis para empezar |
| Servidor del facturador (la API) | Render | Gratis (plan *Free*) |
| Cola cada 5 min (mantiene despierto al servidor) | cron-job.org | Gratis |
| Respaldo diario y cola de reserva | GitHub Actions | Gratis (con el repositorio público) |

> **Plan gratis de Render:** se "duerme" tras 15 minutos sin visitas y tarda casi un minuto
> en despertar. cron-job.org lo visita cada 5 minutos (paso 5b), así que casi siempre está
> despierto. GitHub también tiene la cola cada 5 minutos, pero en la práctica (octubre 2026)
> la ejecuta cada 2 o 3 horas: sirve de reserva, no para mantenerlo despierto. Si alguna vez
> la tienda lo encuentra dormido, la boleta queda pendiente y se emite con
> **"Emitir de nuevo"** en el panel; no se pierde nada. Para producción conviene *Starter*
> (US$ 7 al mes en octubre 2026; revisa el precio en Render) y nunca se dormirá.
>
> **Deja el repositorio público:** GitHub da minutos ilimitados a los repositorios públicos.
> En uno privado, la cola cada 5 minutos gastaría más que los minutos gratis del mes. El
> repositorio no tiene ninguna clave y los respaldos van cifrados.

Necesitas tu PC con la carpeta del facturador (`C:\Users\HP\facturador-sunat`) actualizada:
```
cd facturador-sunat
git checkout main
git pull
npm install
```

---

## Paso 1 — Claves nuevas (en tu PC)

Genera **dos** claves, una para cada uso. Ejecuta dos veces:
```
npm run llave:generar
```
- La primera es la **LLAVE_MAESTRA** (cifra el certificado y la Clave SOL).
- La segunda es la **CLAVE_CRON** (para la cola automática).

Guárdalas en tu gestor de contraseñas. **Si pierdes la LLAVE_MAESTRA hay que volver a cargar
el certificado.** No las pegues en el chat ni en GitHub.

## Paso 2 — Base de datos en Supabase

1. Entra a https://supabase.com → **New project**.
2. Nombre: `facturador`. Región: **East US (North Virginia)**. Crea una contraseña fuerte y
   guárdala en tu gestor.
3. Cuando termine: botón **Connect** (arriba) → pestaña **Connection string** → elige
   **Session pooler**. Copia la dirección; empieza con `postgresql://postgres.`…
   Cambia `[YOUR-PASSWORD]` por la contraseña del punto 2. Esa es tu **DATABASE_URL**.
4. **Project Settings → Database → SSL Configuration → Download certificate.** Abre el
   archivo con el Bloc de notas: todo ese texto es tu **DATABASE_CA_CERT**.

> Supabase gratis pausa el proyecto tras 7 días sin uso. La cola automática del paso 5 lo
> usa cada 5 minutos, así que no se pausará mientras el servidor esté publicado.

## Paso 3 — Servidor en Render

1. Entra a https://render.com con tu cuenta de GitHub.
2. **New → Blueprint** → elige el repositorio **facturador-sunat** → **Connect**.
3. Render lee el archivo `render.yaml` y te pide 4 valores:
   - `DATABASE_URL` → la del paso 2.3
   - `DATABASE_CA_CERT` → el texto del paso 2.4
   - `LLAVE_MAESTRA` → la del paso 1
   - `CLAVE_CRON` → la del paso 1
4. **Apply**. La primera vez tarda unos minutos: instala, crea las tablas y arranca.
5. Copia la dirección que te da Render (ej. `https://facturador-sunat.onrender.com`).
   Ábrela agregando `/v1/salud` al final: debe decir `{"ok":true}`.

## Paso 4 — Tu empresa, el certificado y la llave de la tienda (en tu PC)

En la carpeta del facturador, crea el archivo `.env` (cópialo de `.env.example`) y completa
**solo** estas líneas con los mismos valores del paso 3:
```
DATABASE_URL=...
DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----"
LLAVE_MAESTRA=...
```
Luego, una sola vez:
```
npm run empresa:configurar -- --ruc 20616613074 --razon "CORPORACION AGAMENON S.A.C." --ubigeo 150101 --departamento LIMA --provincia LIMA --distrito LIMA --direccion "TU DIRECCIÓN FISCAL" --regimen MYPE_TRIBUTARIO --desde 2026-01-01 --marca "Espacios y Diseño"
npm run certificado:cargar -- --ruc 20616613074 --pfx "C:\ruta\a\tu\certificado.p12"
npm run llave-api -- crear --ruc 20616613074 --canal "Tienda web" --permisos emitir,consultar,cobrar
```
La contraseña del certificado se escribe cuando la pide; en pantalla salen solo asteriscos.
⚠️ Revisa el ubigeo y la dirección: deben ser los de tu **domicilio fiscal** en la Ficha RUC.
La última orden muestra una llave que empieza con `fk_` **una sola vez**: cópiala para el paso 6.

## Paso 5 — Cola automática y respaldo diario (GitHub)

En GitHub → repositorio **facturador-sunat** → **Settings → Secrets and variables → Actions**:

| Pestaña | Nombre | Valor |
|---|---|---|
| Variables | `FACTURADOR_URL` | la dirección de Render (sin `/` al final) |
| Secrets | `CLAVE_CRON` | la del paso 1 |
| Secrets | `DATABASE_URL` | la del paso 2.3 |
| Secrets | `RESPALDO_CLAVE` | otra clave de `npm run llave:generar`, guárdala en tu gestor |

Luego, en la pestaña **Actions**, abre **cola** y **respaldo** y pulsa **Run workflow** una
vez para comprobar que salen en verde ✅.

## Paso 5b — Mantener despierto el servidor (cron-job.org)

1. Crea una cuenta gratis en https://console.cron-job.org/signup y confirma el correo.
2. **Cronjobs → Crear cronjob**:
   - **Título:** `Facturador cola`
   - **URL:** la dirección de Render + `/v1/cola/procesar`
   - **Horario de ejecución:** *Cada 5 minutos* (expresión `*/5 * * * *`)
3. Pestaña **Avanzado**:
   - **Método:** `POST`
   - **Encabezado:** clave `Authorization`, valor `Bearer ` + tu CLAVE_CRON (con un espacio
     después de `Bearer`)
4. **Crear**. En **Historial** debe salir **200 OK**. La primera puede salir *timeout*
   (Render estaba dormido); un **401** significa que la clave del encabezado está mal.

## Paso 6 — Conectar la tienda (Vercel)

Vercel → proyecto de la tienda → **Settings → Environment Variables**:
- `FACTURADOR_URL` → la dirección de Render
- `FACTURADOR_LLAVE` → la llave `fk_…` del paso 4

Después: **Deployments → … → Redeploy**. (La tienda ya debe tener unido el cambio
"Boletas y facturas automáticas".)

## Paso 6b — Tu usuario del panel (en tu PC)

Para emitir boletas a mano (WhatsApp, Instagram, en persona). Ten el celular a mano con
**Google Authenticator** o **Microsoft Authenticator** instalado.
```
npm run usuario -- crear --email tu@correo.com --nombre "Tu nombre" --ruc 20616613074 --rol DUENO
```
1. Escribe una contraseña nueva (mínimo 10 caracteres; salen asteriscos) y repítela.
2. Aparece un QR: en la app del celular pulsa **+** → **Escanear código QR**.
3. Escribe el código de 6 dígitos que muestra la app.
4. Entra a la dirección de Render + `/panel` con tu correo, tu contraseña y el código del momento.

Si cambias de celular: `npm run usuario -- restablecer-2fa --email tu@correo.com`.

**Sin la PC (solo para el primer usuario):**
1. Render → facturador → **Environment** → agrega `CLAVE_INSTALACION` con una clave que inventes
   (mínimo 16 caracteres, anótala) → **Save changes**.
2. Abre la dirección de Render + `/panel` → **"¿Primera vez? Crea tu usuario de dueño"**.
3. Escribe esa clave, el RUC, tus datos y una contraseña → **"Agregar a mi app autenticadora"** →
   escribe el código que muestra la app → **Activar**.
4. Ya dentro, **borra `CLAVE_INSTALACION` de Render**. De todos modos deja de servir apenas
   existe un usuario.

**Olvidaste tu contraseña o cambiaste de celular:**
- Desde el celular: en Render agrega `CLAVE_RECUPERACION` (una clave que inventes, 16+ caracteres)
  → en `/panel` toca **"¿Olvidaste tu contraseña o cambiaste de celular?"** → clave, correo y
  contraseña nueva → agrega la cuenta otra vez en tu app → código → **Activar**. Después **borra
  `CLAVE_RECUPERACION` de Render**.
- Desde la PC: `npm run usuario -- recuperar --email tu@correo.com`.

## Paso 6c — Avisos por correo (opcional, gratis)

El facturador te escribe 7 días, 3 días y el mismo día del vencimiento de tu declaración, cuando
el certificado está por vencer (60, 30 y 7 días) y cuando SUNAT rechaza un comprobante. Llega a
los usuarios con rol DUEÑO o ADMIN de cada empresa.

1. Crea una cuenta gratis en https://resend.com con **el mismo correo** de tu usuario del panel.
2. **API Keys → Create API Key** → cópiala.
3. Render → facturador → **Environment** → agrega:
   - `RESEND_API_KEY` → la clave del punto 2
   - `AVISOS_DESDE` → `Facturador <onboarding@resend.dev>`
4. **Save changes** (Render se reinicia solo).

Sin dominio propio, Resend solo deja enviar a tu propio correo; para escribir a otros usuarios
hay que verificar un dominio en Resend y cambiar `AVISOS_DESDE`. Para no recibir avisos de una
empresa: `npm run empresa:modulos -- --ruc … --desactivar avisos`.

## Paso 7 — Prueba completa

1. Haz un pedido en tu tienda con Yape por un monto pequeño.
2. En el panel, márcalo como **Pagado** y escribe el número de operación.
3. Debe aparecer **"Boleta B001-…"**. Pulsa **PDF A4**: dirá *"PRUEBA - SIN VALOR LEGAL"*
   porque estamos en BETA.

Si algo falla, mándame una captura del mensaje.

---

## Restaurar un respaldo (solo si alguna vez se pierde la base)

1. GitHub → **Actions → respaldo** → el día que quieras → **Artifacts** → descarga.
2. En tu PC (Git Bash):
   ```
   openssl enc -d -aes-256-cbc -pbkdf2 -in respaldo.sql.gz.enc -out respaldo.sql.gz
   gunzip respaldo.sql.gz
   ```
3. Cárgalo en una base **nueva y vacía** (nunca encima de la que está funcionando) con
   `psql "<DATABASE_URL de la base nueva>" -f respaldo.sql`.

La lista de producción exige haber restaurado un respaldo de prueba al menos una vez:
hazlo con una base de prueba cuando tengas unos días de datos.
