#!/usr/bin/env bash
# Start the Fitness Hub in this terminal: http://127.0.0.1:8642/ (loopback only). Stop with Ctrl+C.
# This is for a PC or laptop. On the home server the hub runs as a service on a private Unix socket
# instead (bash deploy/install.sh, see MIGRATE.md): don't start a second copy there, because this
# one opens TCP port 8642, which other accounts on the server could reach.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet fitness-hub.service 2>/dev/null; then
  echo "The Fitness Hub already runs here as a service (systemctl --user status fitness-hub)." >&2
  echo "Use it through the SSH tunnel from your PC; don't start a second copy." >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 not found. On Ubuntu: sudo apt install python3" >&2; exit 1; }
exec python3 -I server.py "$@"
