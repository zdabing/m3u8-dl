#!/usr/bin/env bash
set -euo pipefail

if [[ -z ${DS_BROWSER_ORIGINS:-} ]]; then
  exec "$@"
fi

if [[ -z ${DS_SECRET:-${DS_TOKEN:-}} ]]; then
  echo 'Set DS_SECRET before enabling browser capture.' >&2
  exit 1
fi
if [[ ! ${DS_BROWSER_VNC_PASSWORD:-} =~ ^[a-zA-Z0-9]{8}$ ]]; then
  echo 'DS_BROWSER_VNC_PASSWORD must be eight letters or digits.' >&2
  exit 1
fi

DS_BROWSER_KEY=$(node -p 'require("node:crypto").randomBytes(24).toString("base64url")')
export DS_BROWSER_KEY
export DS_BROWSER_ENDPOINT="ws://127.0.0.1:9323/$DS_BROWSER_KEY"
export DS_BROWSER_WINDOW="${DS_BROWSER_WINDOW:-http://localhost:6080/vnc.html?autoconnect=1&resize=scale}"

children=()
stop() {
  if ((${#children[@]})); then kill "${children[@]}" 2>/dev/null || true; fi
  wait || true
}
trap stop EXIT
trap 'exit 0' TERM INT

env -u DS_SECRET -u DS_TOKEN gosu node xvfb-run -a -s '-screen 0 1280x800x24' bash /app/browser/session.sh &
children+=("$!")
"$@" &
children+=("$!")
wait -n "${children[@]}"
