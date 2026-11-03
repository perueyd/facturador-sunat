# Prueba real en SUNAT beta

Esta prueba envía comprobantes **de prueba** al ambiente beta de SUNAT, que solo
revisa que los XML estén bien armados. **Nada tiene validez legal** y no se usa tu
Clave SOL ni tu certificado:

- Usuario público de pruebas de SUNAT: **tu RUC + `MODDATOS`**, clave **`MODDATOS`**
  ([pautas oficiales del servicio beta](https://orientacion.sunat.gob.pe/12-pautas-servicio-beta)).
- La firma se hace con un certificado de prueba que se genera al momento.

Sirve para confirmar lo que no se puede comprobar sin SUNAT:

1. Que SUNAT acepta nuestros XML de boleta, factura, factura al crédito, nota de crédito y comunicación de baja.
2. Si acepta firmas **SHA-256**, además de SHA1.
3. El código correcto para boletas **sin cliente identificado** ("clientes varios").

## Opción A · Desde tu computadora (recomendado)

Necesitas [Node.js 22](https://nodejs.org) (descarga la versión "LTS") y Git.

```bash
git clone https://github.com/perueyd/facturador-sunat.git
cd facturador-sunat
npm install
npm run sunat:beta -- --ruc 20XXXXXXXXX      # tu RUC 20
```

Al terminar verás una tabla con una fila por comprobante:

| resultado | significa |
|---|---|
| `ACEPTADO` | SUNAT lo aceptó. |
| `ACEPTADO_OBS` | Lo aceptó con observaciones (hay que corregir algo menor). |
| `RECHAZO` / `RECHAZADO` | SUNAT lo rechazó: el detalle trae el código y el motivo. |
| `EXCEPCION` | SUNAT no lo procesó (usuario, formato del archivo, etc.). |
| `SIN CONEXIÓN` | No se pudo conectar con SUNAT: revisa tu internet y vuelve a intentar. |

**Copia la tabla y envíamela.** No contiene datos sensibles. Los archivos enviados
y las constancias quedan en la carpeta `resultados-beta/`, que no se sube a GitHub.

## Opción B · Desde este entorno en la nube

Hoy la red del entorno bloquea `e-beta.sunat.gob.pe`. Para habilitarla:

1. En la barra de título de la sesión, abre el menú del **entorno en la nube** → **Editar**.
2. En **Network access** (acceso de red), agrega `e-beta.sunat.gob.pe` en
   **Allowed domains**, dejando marcada la casilla de gestores de paquetes.
   (Guía: <https://code.claude.com/docs/en/cloud-environments#network-access>)
3. Avísame y yo mismo corro la prueba. En ese entorno Node no usa el proxy por su cuenta: se corre con
   `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm run sunat:beta -- --ruc …`
   (así se hizo el 03/11/2026: 15 de 15 aceptados).

Para producción, más adelante, el servidor donde viva el facturador tendrá que
poder conectarse a `e-factura.sunat.gob.pe`.
