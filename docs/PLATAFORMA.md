# El facturador como servicio para otros negocios

Guía para el dueño de la plataforma: cómo dar de alta clientes, cobrarles y vigilar que todo
funcione. Al final, la lista de **proyectos pendientes**.

## Antes de vender (obligatorio)

1. **Confirmar con SUNAT o con un contador si debes inscribirte como PSE** (Proveedor de Servicios
   Electrónicos). El facturador está diseñado para que cada cliente firme con **su propio**
   certificado y use **su propio** usuario SOL secundario (SEE - Del Contribuyente). Desde aquí no
   se pudo revisar la normativa vigente (sunat.gob.pe bloqueado): **no asumir**. Anotar aquí la
   fuente y la fecha cuando se confirme.
2. Términos del servicio y política de datos personales (Ley 29733): guardarás certificados y claves
   SOL de terceros (cifrados).
3. Pasar a planes de pago: Render **Starter** (no se duerme) y Supabase **Pro**. El plan gratis no
   sirve para clientes que pagan.

## Planes (propuesta inicial, se cambian en el panel → Plataforma → Precios)

| Plan | Mensual | Anual | Límites |
|---|---|---|---|
| Emprendedor | S/ 39 | S/ 390 | 150 comprobantes al mes, 2 usuarios |
| Negocio | S/ 69 | S/ 690 | 600 comprobantes al mes, 5 usuarios |
| Empresa | S/ 119 | S/ 1,190 | sin límites |

Compara con los precios de otros facturadores del mercado antes de fijarlos.

## Cómo funciona el cobro

- Empresa nueva de un cliente: **14 días de prueba**. Una empresa propia (marca "Es mía") no
  tiene plan ni límites.
- El cliente te paga (Yape, transferencia…) → en **Plataforma → el cliente → Registrar pago**.
  Si aún no venció, el mes se suma desde su vencimiento (no pierde días por pagar antes).
- 7 días antes de vencer: "por vencer". Vencido: **5 días de gracia** (puede emitir, ve un aviso).
  Después ya no emite boletas ni facturas **nuevas**.
- **Nunca** se bloquea por falta de pago: enviar lo que quedó en cola, consultar y descargar sus
  comprobantes, notas de crédito, bajas. Son obligaciones del cliente con SUNAT.
- Los pagos registrados no se borran ni se cambian (historial). Suspender o cancelar pide motivo.

## Vigilancia automática (te llega por correo; requiere Resend, ver PUBLICAR.md paso 6c)

En cada pasada del cron se revisa y se avisa UNA vez: errores internos del servidor, comprobantes
con más de 2 horas sin llegar a SUNAT, 3 o más rechazos en un día, certificados por vencer (15 días)
o vencidos, planes por vencer (3 días) o vencidos, base de datos al 80 % del plan.
Todo se ve también en el panel → **Plataforma → Salud de la plataforma**.

## ¿Para cuántos clientes alcanza? (estimado)

- Render Starter + Supabase Pro (≈ US$ 32 al mes): **50 a 150 negocios pequeños** (hasta unas
  1,000 boletas al mes cada uno). Lo primero que se agota es el espacio: los XML y CDR se guardan
  5 años. La vigilancia avisa al 80 %.
- Más allá: un servidor más grande y guardar los archivos en un almacenamiento aparte.

## Proyectos pendientes (no empezados)

| Proyecto | Por qué espera |
|---|---|
| Invitación por enlace (el cliente crea su contraseña y su 2FA solo) | Siguiente paso |
| Lista de configuración del cliente (certificado, usuario SOL, prueba en beta, producción) | Siguiente paso |
| Inventario: stock de seguridad, tiempo de entrega por proveedor, punto de reorden, Kardex | Siguiente paso |
| Guías de remisión electrónicas (GRE) | Usa otra API de SUNAT (REST con token): hay que leer el manual oficial vigente antes de programar |
| Autocompletar datos por RUC/DNI (padrón SUNAT) | Necesita acceso a sunat.gob.pe |
| SIRE (registros de ventas y compras) | Necesita el manual oficial |
| Cobro automático con tarjeta (Culqi, suscripción) | Primero validar el negocio con cobro manual |
| Tienda en línea como plantilla para clientes (una sola, configurable; nunca copias) | Proyecto aparte, después de tener clientes del facturador |
| Unir la tienda Espacios y Diseño con el facturador | Decisión del dueño: por ahora siguen separados |
