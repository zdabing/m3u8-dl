#!/usr/bin/env bash
set -euo pipefail
umask 077
password_file=$(mktemp)
children=()
stop() {
  if ((${#children[@]})); then kill "${children[@]}" 2>/dev/null || true; fi
  wait || true
  rm -f "$password_file"
}
trap stop EXIT
trap 'exit 0' TERM INT
printf '%s\n' "$DS_BROWSER_VNC_PASSWORD" > "$password_file"
unset DS_BROWSER_VNC_PASSWORD
fluxbox &
children+=("$!")
x11vnc -quiet -localhost -forever -shared -rfbport 5900 -passwdfile "$password_file" &
children+=("$!")
websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &
children+=("$!")
node /app/browser/start.cjs &
children+=("$!")
wait -n "${children[@]}"
