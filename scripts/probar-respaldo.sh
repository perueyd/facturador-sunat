#!/usr/bin/env bash
# Prueba que un respaldo SÍ se puede restaurar (lista "Antes de pasar a producción").
#
# Restaura el archivo cifrado en una base VACÍA y desechable, y compara tabla por tabla con lo
# que tenía la base real antes del respaldo: ninguna tabla puede volver con menos filas, y los
# candados de la base (disparadores que impiden borrar o cambiar comprobantes) tienen que volver.
# Un respaldo que no se puede restaurar no sirve de nada, y eso solo se sabe probándolo.
#
# Uso:  RESPALDO_CLAVE=… bash scripts/probar-respaldo.sh <conteos-antes.txt> <respaldo.sql.gz.enc> <URL base vacía>
#       Los conteos se sacan ANTES del respaldo con:  bash scripts/probar-respaldo.sh --contar <URL base real>
# PSQL puede apuntar a otro psql (en GitHub: el de la imagen postgres:17).
# Nunca uses la base real como destino: se le cargaría el respaldo encima.
set -euo pipefail
PSQL="${PSQL:-psql}"

# Filas de cada tabla del esquema public y cantidad de disparadores, en líneas "tabla filas".
contar() {
  $PSQL "$1" -X -q -At -F ' ' -v ON_ERROR_STOP=1 -c "
    SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
      FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    UNION ALL
    SELECT '(disparadores)', count(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY 1"
}

if [ "${1:-}" = "--contar" ]; then contar "$2"; exit 0; fi

ANTES="$1"; ARCHIVO="$2"; DESTINO="$3"
[ -n "${RESPALDO_CLAVE:-}" ] || { echo "Falta RESPALDO_CLAVE." >&2; exit 1; }
[ -s "$ANTES" ] || { echo "No hay conteos de la base real." >&2; exit 1; }

# El destino debe estar vacío: así nunca se carga encima de una base con datos.
if [ "$($PSQL "$DESTINO" -X -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" != "0" ]; then
  echo "La base de destino no está vacía: no se restaura encima." >&2; exit 1
fi

# Restaurar. Sin ON_ERROR_STOP: el respaldo de Supabase trae cosas propias de Supabase
# (roles, extensiones, esquemas auth y storage) que una base común no tiene; esos errores no
# importan. Lo que importa se comprueba abajo, tabla por tabla.
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:RESPALDO_CLAVE -in "$ARCHIVO" | gunzip | $PSQL "$DESTINO" -X -q >/dev/null 2>restaurar.log || true

DESPUES="$(mktemp)"
contar "$DESTINO" >"$DESPUES"

fallas=0
while read -r tabla antes; do
  despues="$(awk -v t="$tabla" '$1 == t { print $2 }' "$DESPUES")"
  if [ -z "$despues" ]; then
    echo "❌ $tabla: no volvió en el respaldo"; fallas=$((fallas + 1))
  elif [ "$despues" -lt "$antes" ]; then
    # Estas dos tablas borran a propósito avisos ya resueltos; no es una pérdida.
    case "$tabla" in avisos_enviados|avisos_plataforma) echo "• $tabla: $despues (antes $antes, se limpian solas)" ;;
      *) echo "❌ $tabla: $despues filas, antes había $antes"; fallas=$((fallas + 1)) ;; esac
  else
    echo "✅ $tabla: $despues"
  fi
done <"$ANTES"

if [ "$fallas" -gt 0 ]; then
  echo "El respaldo NO se restauró completo ($fallas problemas). Primeros errores de la carga:"; head -20 restaurar.log
  exit 1
fi
echo "Respaldo restaurado y comprobado: todas las tablas y los candados volvieron completos."
