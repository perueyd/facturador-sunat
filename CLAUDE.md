# CLAUDE.md — Reglas del proyecto "Facturador electrónico SUNAT"

Este archivo contiene las reglas OBLIGATORIAS del proyecto. Claude debe leerlas y
respetarlas en cada sesión, sin excepción. Si una petición contradice estas reglas,
Claude debe avisar antes de hacer nada.

## Qué es este proyecto

Facturador electrónico propio para SUNAT (SEE - Del Contribuyente), sin proveedores
externos (sin OSE ni PSE). Servicio independiente con su propia API. Clientes del
servicio: la tienda `tarimas-cabeceras-store` (Vercel + Google Sheets "Pedidos ED"),
emisión manual (WhatsApp, Instagram, en persona) y, a futuro, otros negocios.

- Empresa principal: Corporación Agamenón S.A.C. (RUC 20, Régimen MYPE Tributario).
  Muebles de melamina, colchones y accesorios. Primera marca: "Espacios y Diseño".
- Segunda empresa: RUC 10 (persona natural), servicio de taxi. Régimen por confirmar.
- Precios con IGV incluido (18 %), salvo operaciones exoneradas.
- El dueño NO es programador experto: explicar todo en pasos simples, en español.

## Forma de trabajo

1. Avanzar por fases y DETENERSE al final de cada una para que el dueño apruebe:
   1. Plan y diseño de base de datos
   2. Generación de XML UBL 2.1
   3. Firma digital
   4. Envío a SUNAT beta
   5. PDF con QR
   6. API y conexión con la tienda
   7. Después: módulos futuros, uno por fase (ver `docs/PLAN.md`).
2. Trabajar siempre en ramas. Mostrar los cambios antes de unirlos a `main`.
3. Al terminar cada fase: revisión de seguridad del código.
4. Mantener `README.md` simple: qué hace y cómo usarlo.
5. No programar nada de una fase que no esté aprobada.

## Reglas tributarias y de SUNAT (para evitar errores)

- Trabajar SIEMPRE primero en el ambiente **beta** de SUNAT. Producción solo con
  autorización expresa y escrita del dueño, y solo después de cumplir la lista
  "Antes de pasar a producción" de `docs/PLAN.md`.
- Antes de programar algo que dependa de SUNAT, revisar la documentación oficial
  vigente (formatos, plazos, catálogos, códigos de error). **No asumir nada de memoria.**
  Anotar en el código o en `docs/` la fuente y fecha consultada.
- Verificar cada regla tributaria en la normativa vigente de SUNAT.
- Tasas (IGV, renta), UIT, cuotas, tramos, límites (S/ 700 de boleta, límites del
  Nuevo RUS, etc.) son **parámetros configurables con fecha de vigencia** en la base
  de datos. Nunca fijos en el código.

## Reglas de comprobantes

- Correlativos sin saltos ni duplicados (ej. `B001-00000001`), generados en
  PostgreSQL dentro de una transacción con bloqueo de fila. **Nunca Google Sheets
  para correlativos.**
- Un solo correlativo por serie, sin importar el canal.
- Idempotencia: si el mismo pedido llega dos veces, devolver el comprobante ya
  emitido; nunca emitir dos.
- Validar antes de enviar:
  - DNI: 8 dígitos.
  - RUC: 11 dígitos con dígito verificador correcto.
  - Boleta mayor a S/ 700 (parámetro configurable): documento del cliente obligatorio.
  - Factura: RUC y razón social del cliente obligatorios.
- Dinero: cálculos con decimales exactos (librería decimal / `NUMERIC` en PostgreSQL).
  **Prohibido usar `number` de JavaScript para montos.** Redondeo a 2 decimales en
  totales según las reglas de SUNAT.
- Si SUNAT no responde: el comprobante queda "pendiente" en la cola y se reintenta
  solo. Nunca se pierde.
- Errores de SUNAT siempre explicados en español claro, diciendo qué corregir.
- **Nunca borrar comprobantes.** Se corrigen con nota de crédito o se anulan con
  comunicación de baja / resumen diario, guardando quién, cuándo y por qué.
- Guardar log de cada acción y respaldo de todos los XML y CDR por al menos 5 años.

## Multiempresa

- Cada empresa con su RUC, datos, certificado, credenciales SOL y correlativos
  totalmente separados. Toda tabla de negocio lleva `empresa_id`.
- Un usuario puede manejar varias empresas y cambiar entre ellas.
- El régimen (Nuevo RUS, RER, MYPE Tributario, General) se configura por empresa y
  activa solo los comprobantes, impuestos y alertas que correspondan. En Nuevo RUS:
  bloquear facturas y alertar al acercarse a los límites.
- Cada comprobante registra la marca y el canal de origen.

## Calidad y seguridad

- Node.js + TypeScript en modo estricto.
- PostgreSQL con transacciones; cola de envíos con reintentos.
- Pruebas automáticas obligatorias para: cálculos, validaciones, correlativos y
  envíos a SUNAT beta. No se une código con pruebas fallando.
- Ambientes separados de pruebas y producción (bases de datos y llaves distintas).
- Certificados, claves, Clave SOL y tokens SOLO en variables de entorno o cifrados
  en la base de datos. **Nunca en el código ni en GitHub.** Revisar `.gitignore`.
- Usar un usuario SOL secundario con permisos mínimos, nunca la Clave SOL principal.
- Datos sensibles cifrados, login con verificación en dos pasos, roles de usuario,
  límite de intentos e historial de acciones.
- Llaves de API distintas por canal, guardadas como hash, desactivables.
- Respaldos diarios automáticos, registro de errores y alertas cuando algo falle.
- Los cálculos de impuestos y finanzas se muestran siempre como **estimados**.
- Antes de cada commit: `npm test` y `npm run analizar` (TypeScript + knip) sin errores, y
  revisar `git status` para que ningún archivo nuevo quede fuera. Mejorar lo existente en vez
  de agregar capas encima, y eliminar el código que no se use.

## Documentos de referencia

- `docs/PLAN.md` — plan general, arquitectura, fases y hallazgos de SUNAT.
- `docs/BASE_DE_DATOS.md` — diseño de la base de datos.
- `docs/DESARROLLO.md` — arquitectura, convenciones y cómo agregar cosas.
- `docs/API.md` — API para canales.
- `docs/PUBLICAR.md` — publicar en Supabase + Render + GitHub Actions.
- `docs/SEGURIDAD.md` — revisión de seguridad: qué está protegido y qué queda pendiente.
- `docs/PLATAFORMA.md` — el facturador como servicio: planes, cobro, vigilancia y proyectos pendientes.
