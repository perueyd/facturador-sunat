# Revisión del contador antes de producción

Es uno de los puntos de la lista "Antes de pasar a producción" (`docs/PLAN.md`). El
facturador ya pasa sus pruebas automáticas, pero un contador tiene que mirar los comprobantes
**como los vería SUNAT o un cliente**: así se detectan errores de criterio que un programa no ve.

## Qué llevarle

Descarga estos PDF del panel (**Comprobantes** → el comprobante → **PDF**). Dicen "BETA" y no
tienen valor legal; sirven solo para revisar.

1. Una **boleta** sin documento del cliente (venta menor a S/ 700).
2. Una **boleta** con DNI.
3. Una **factura** a un RUC, **al contado**.
4. Una **factura al crédito** con cuotas.
5. Una **boleta o factura con descuento** (cupón u oferta de la tienda).
6. Una **nota de crédito** que anule o devuelva parte de una de las anteriores.

Si alguna no existe todavía, emítela en el panel antes de ir: en beta no cuenta como venta.

## Qué pedirle que revise

| Tema | Pregunta para el contador |
|---|---|
| Datos del emisor | ¿Razón social, RUC, dirección y nombre comercial son los de la Ficha RUC? |
| IGV | ¿El IGV (18 %) y la base están bien separados del precio con IGV incluido? |
| Descuentos | ¿El descuento está bien como "descuento global que afecta la base"? |
| Factura al crédito | ¿Las cuotas y las fechas de pago están bien expresadas? |
| Nota de crédito | ¿El motivo y el comprobante que modifica son correctos? |
| Régimen | Corporación Agamenón está en **MYPE Tributario**: ¿las tasas y alertas configuradas son las correctas? |
| Adelantos | Cuando un cliente paga por adelantado un mueble a medida, ¿cómo y cuándo se emite el comprobante? |
| Leyendas | ¿Falta alguna leyenda obligatoria en el PDF (monto en letras, código QR, etc.)? |

## Qué traer de vuelta

Escríbeme lo que diga el contador, aunque sea "todo está bien". Si encuentra algo, lo corrijo
y se vuelve a revisar. Anótalo aquí con la fecha:

- Fecha de la revisión: ________
- Contador: ________
- Resultado: ________
