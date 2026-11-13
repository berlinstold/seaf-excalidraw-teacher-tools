#!/bin/bash
# =============================================================================
# Seafile Excalidraw Teacher Tools – Installer für Unraid / Docker   (v1.1)
# https://github.com/berlinstold/seaf-excalidraw-teacher-tools
#
#   ./install.sh install   [CONTAINERNAME]   (Standard: seafile)
#   ./install.sh update    [CONTAINERNAME]   nur JS-Datei aktualisieren
#   ./install.sh uninstall [CONTAINERNAME]
#   ./install.sh diagnose  [CONTAINERNAME]   zeigt Pfade/Konfiguration an, ändert nichts
#
# Ablauf:
#   1. Host-Pfad des /shared-Volumes ermitteln
#   2. excalidraw-timer.js nach <shared>/plugins/ kopieren
#   3. Die Seahub-nginx-Konfiguration im Container finden (Standardpfad oder
#      per "nginx -T" vom laufenden nginx erfragt) und ergänzen (mit Backup)
#   4. nginx -t prüfen (bei Fehler: Backup zurück), nginx neu laden
# =============================================================================
set -euo pipefail

ACTION="${1:-install}"
CONTAINER="${2:-seafile}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS_SRC="$SCRIPT_DIR/excalidraw-timer.js"
MARK_BEGIN="# >>> EXCALIDRAW-TIMER"
MARK_END="# <<< EXCALIDRAW-TIMER <<<"
STAMP="$(date +%Y%m%d-%H%M%S)"

die()  { echo "FEHLER: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "!!  $*" >&2; }
dx()   { docker exec "$CONTAINER" "$@"; }

command -v docker >/dev/null || die "docker nicht gefunden."
docker inspect "$CONTAINER" >/dev/null 2>&1 \
  || die "Container '$CONTAINER' nicht gefunden. Name mit 'docker ps' prüfen und als 2. Parameter angeben."

SHARED_HOST="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/shared"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")"
[ -n "$SHARED_HOST" ] || die "Im Container '$CONTAINER' ist kein Volume unter /shared eingebunden."
PLUGIN_DIR="$SHARED_HOST/plugins"

VERSION="$(grep -m1 '@version' "$JS_SRC" 2>/dev/null | awk '{print $3}')"
[ -n "$VERSION" ] || VERSION="1"

# -----------------------------------------------------------------------------
# nginx-Konfiguration finden
#   CONF_CT    Pfad im Container (Symlinks aufgelöst)
#   CONF_HOST  Pfad auf dem Host, falls die Datei im /shared-Volume liegt
# -----------------------------------------------------------------------------
CONF_CT=""
CONF_HOST=""

nginx_conf_files() {
  dx nginx -T 2>/dev/null | sed -n 's/^# configuration file \(.*\):$/\1/p' | sort -u
}

find_conf() {
  dx sh -c 'command -v nginx' >/dev/null 2>&1 \
    || die "Im Container läuft kein nginx. Bitte Variante B (externer Proxy) oder C (Userscript) aus der Anleitung nutzen."

  local candidates f
  candidates="/shared/nginx/conf/seafile.nginx.conf
/etc/nginx/sites-enabled/seafile.nginx.conf
$(nginx_conf_files)"

  for f in $candidates; do
    if dx sh -c "[ -f '$f' ] && grep -qE 'proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):8000' '$f'" 2>/dev/null; then
      CONF_CT="$(dx readlink -f "$f")"
      break
    fi
  done
  [ -n "$CONF_CT" ] || die "Keine nginx-Datei mit 'proxy_pass http://127.0.0.1:8000' gefunden. Bitte './install.sh diagnose $CONTAINER' ausführen und die Ausgabe schicken."

  case "$CONF_CT" in
    /shared/*) CONF_HOST="$SHARED_HOST${CONF_CT#/shared}" ;;
    *)         CONF_HOST="" ;;
  esac
  info "nginx-Konfiguration im Container: $CONF_CT"
  if [ -n "$CONF_HOST" ]; then
    info "                 auf dem Host:     $CONF_HOST"
  else
    warn "Die Datei liegt NICHT im /shared-Volume. Änderungen gehen verloren, wenn der Container"
    warn "neu erstellt wird (z. B. bei einem Update über Unraid). Danach einfach erneut ausführen."
  fi
}

# Arbeitskopie holen / zurückschreiben
WORK=""
load_conf() {
  WORK="$(mktemp)"
  if [ -n "$CONF_HOST" ]; then cp "$CONF_HOST" "$WORK"; else docker cp "$CONTAINER:$CONF_CT" "$WORK" >/dev/null; fi
}
store_conf() { # $1 = Datei
  if [ -n "$CONF_HOST" ]; then cat "$1" > "$CONF_HOST"; else docker cp "$1" "$CONTAINER:$CONF_CT" >/dev/null; fi
}
backup_conf() {
  mkdir -p "$PLUGIN_DIR/backup"
  BACKUP="$PLUGIN_DIR/backup/$(basename "$CONF_CT").bak-$STAMP"
  cp "$WORK" "$BACKUP"
  info "Backup der nginx-Konfiguration: $BACKUP"
}

copy_js() {
  [ -f "$JS_SRC" ] || die "excalidraw-timer.js nicht neben install.sh gefunden."
  mkdir -p "$PLUGIN_DIR"
  cp "$JS_SRC" "$PLUGIN_DIR/excalidraw-timer.js"
  chmod 644 "$PLUGIN_DIR/excalidraw-timer.js"
  info "JS-Datei kopiert nach $PLUGIN_DIR/excalidraw-timer.js (Version $VERSION)"
}

test_and_reload() { # $1 = Backup-Datei (optional)
  if ! dx nginx -t; then
    if [ -n "${1:-}" ]; then
      store_conf "$1"
      die "nginx-Konfiguration ungültig – Backup wurde wiederhergestellt."
    fi
    die "nginx-Konfiguration ungültig."
  fi
  dx nginx -s reload
  info "nginx im Container neu geladen."
}

remove_block() { sed -i "/$MARK_BEGIN/,/$MARK_END/d" "$1"; }

insert_block() { # $1 = Eingabe, $2 = Ausgabe
  awk -v ver="$VERSION" -v mb="$MARK_BEGIN" -v me="$MARK_END" -v sq="'" '
    /^[[:space:]]*location[[:space:]]+\/[[:space:]]*\{/ {
      print "    " mb " (Plugin-Dateien) >>>"
      print "    location /seafile-plugins/ {"
      print "        alias /shared/plugins/;"
      print "        add_header Cache-Control \"no-cache\";"
      print "    }"
      print "    " me
      print $0
      print "        " mb " (Skript einbinden) >>>"
      print "        proxy_set_header Accept-Encoding \"\";"
      print "        sub_filter_once on;"
      print "        sub_filter " sq "</head>" sq " " sq "<script src=\"/seafile-plugins/excalidraw-timer.js?v=" ver "\" defer></script></head>" sq ";"
      print "        " me
      found = 1
      next
    }
    { print }
    END { if (!found) exit 3 }
  ' "$1" > "$2"
}

case "$ACTION" in
  install)
    info "Seafile-Daten (/shared) liegen auf dem Host unter: $SHARED_HOST"
    find_conf
    copy_js
    load_conf
    backup_conf
    remove_block "$WORK"
    NEW="$(mktemp)"
    insert_block "$WORK" "$NEW" \
      || die "Kein 'location / {' in $CONF_CT gefunden – bitte manuell nach Anleitung vorgehen."
    store_conf "$NEW"
    rm -f "$NEW" "$WORK"
    info "nginx-Konfiguration ergänzt."
    test_and_reload "$BACKUP"
    info "Fertig. Whiteboard im Browser neu laden (Strg+F5)."
    ;;

  update)
    copy_js
    find_conf
    load_conf
    if grep -q "$MARK_BEGIN" "$WORK"; then
      backup_conf
      sed -i -E "s#(/seafile-plugins/excalidraw-timer\.js\?v=)[^\"]*#\1$VERSION#" "$WORK"
      store_conf "$WORK"
      test_and_reload "$BACKUP"
    else
      warn "Plugin-Zeilen fehlen in der nginx-Konfiguration – bitte './install.sh install $CONTAINER' ausführen."
    fi
    rm -f "$WORK"
    info "Update abgeschlossen."
    ;;

  uninstall)
    find_conf
    load_conf
    if grep -q "$MARK_BEGIN" "$WORK"; then
      backup_conf
      remove_block "$WORK"
      store_conf "$WORK"
      test_and_reload "$BACKUP"
    fi
    rm -f "$WORK" "$PLUGIN_DIR/excalidraw-timer.js"
    info "Plugin entfernt (Backups bleiben in $PLUGIN_DIR/backup)."
    ;;

  diagnose)
    echo "--- Container:  $CONTAINER ($(docker inspect -f '{{.Config.Image}}' "$CONTAINER"))"
    echo "--- Volumes:"
    docker inspect -f '{{range .Mounts}}    {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' "$CONTAINER"
    echo "--- nginx im Container:"
    dx sh -c 'command -v nginx && nginx -v' 2>&1 | sed 's/^/    /' || echo "    (kein nginx)"
    echo "--- Von nginx geladene Konfigurationsdateien:"
    nginx_conf_files | while read -r f; do
      echo "    $f -> $(dx readlink -f "$f")"
    done
    echo "--- Dateien mit Seahub-Proxy (127.0.0.1:8000):"
    for f in $(nginx_conf_files); do
      dx sh -c "grep -lE 'proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):8000' '$f'" 2>/dev/null | sed 's/^/    /' || true
    done
    echo "--- Inhalt von /shared:"
    dx ls -la /shared 2>&1 | sed 's/^/    /' || true
    ;;

  *)
    echo "Verwendung: $0 {install|update|uninstall|diagnose} [CONTAINERNAME]"
    exit 1
    ;;
esac
