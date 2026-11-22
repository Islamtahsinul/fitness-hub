#!/usr/bin/env bash
# Open an SSH tunnel from this computer (macOS, Linux, WSL or Git Bash) to the Fitness Hub on your
# home server, and open http://127.0.0.1:8642/ here as soon as the hub answers through it.
#
#   bash connect_from_pc.sh USER@HOMESERVER UID
#     UID is your numeric user ID on the server: run  id -u  there (the hosting report gives it).
#     Or set FITNESS_HUB_SERVER and FITNESS_HUB_SERVER_UID, or answer the two questions.
#
# On the server the hub listens only on a Unix socket, /run/user/UID/fitness-hub/hub.sock, which only
# your account there can open; it has no TCP port. This forwards 127.0.0.1:8642 on this computer
# (loopback only) to that socket, so nothing is exposed on either network. Keep the local port at
# 8642: the hub only accepts requests addressed to 127.0.0.1:8642 or localhost:8642.
#   ExitOnForwardFailure=yes   stop at once if the tunnel can't be set up
#   ServerAliveInterval=30     notice a dead connection within about 90 seconds and exit
# Use an SSH key so you aren't asked for a password every time (see the hosting guide).
set -euo pipefail

LOCAL_PORT=8642

die() { printf '%s\n' "$*" >&2; exit 1; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

hub_answers() {  # GET /api/health through the tunnel: true only for the Fitness Hub's own answer
  local body
  if command -v curl >/dev/null 2>&1; then
    body="$(curl -q -s --noproxy '*' --max-time 3 "http://127.0.0.1:$LOCAL_PORT/api/health" 2>/dev/null)" || return 1
  else
    body="$( { exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT" \
               && printf 'GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:%s\r\n\r\n' "$LOCAL_PORT" >&3 \
               && cat <&3; } 2>/dev/null )" || return 1
  fi
  case "$body" in *'"app": "fitness-hub"'* | *'"app":"fitness-hub"'*) return 0 ;; *) return 1 ;; esac
}

open_url() {
  if [ "${FITNESS_HUB_TESTING:-}" = 1 ] && [ -n "${FITNESS_HUB_OPEN_CMD:-}" ]; then
    $FITNESS_HUB_OPEN_CMD "$1"  # tests only: show what would be opened
    return
  fi
  case "$(uname -s 2>/dev/null)" in
    Darwin) open "$1" ;;
    MINGW* | MSYS* | CYGWIN*) cmd.exe //c start "" "$1" ;;
    *)
      if grep -qi microsoft /proc/version 2>/dev/null && command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start "" "$1" >/dev/null 2>&1   # WSL: the Windows browser
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 &
      else
        printf 'Open %s in your browser.\n' "$1"
      fi ;;
  esac
}

main() {
  [ "${1:-}" != "--" ] || shift
  local server="${1:-${FITNESS_HUB_SERVER:-}}" uid="${2:-${FITNESS_HUB_SERVER_UID:-}}" sock url pid rc tries
  command -v ssh >/dev/null 2>&1 \
    || die "ssh was not found. Windows: Settings > System > Optional features > OpenSSH Client. Linux: install openssh-client."
  if [ -z "$server" ]; then
    read -r -p "Home server login (for example user@homeserver): " server || true
  fi
  case "$server" in
    "") die "No server login given." ;;
    -*) die "That doesn't look like user@host: $server" ;;
  esac
  local login_re='^[]A-Za-z0-9._@%:[-]+$'  # user@host, an ssh_config alias, or user@[IPv6]
  [[ "$server" =~ $login_re ]] || die "That doesn't look like user@host: $server"
  if [ -z "$uid" ]; then
    read -r -p "Your user ID on the server (run  id -u  there): " uid || true
  fi
  [[ "$uid" =~ ^[0-9]{1,10}$ ]] || die "Your user ID on the server must be a number (run  id -u  there), not '$uid'."
  if [ -n "${FITNESS_HUB_LOCAL_PORT:-}" ]; then
    [ "${FITNESS_HUB_TESTING:-}" = 1 ] || die "FITNESS_HUB_LOCAL_PORT is for the tests only (with FITNESS_HUB_TESTING=1): the hub needs local port 8642."
    LOCAL_PORT="$FITNESS_HUB_LOCAL_PORT"
  fi
  if port_busy "$LOCAL_PORT"; then
    die "Port $LOCAL_PORT is already in use on this computer. If a copy of the hub is running here, stop it (close its window), then try again."
  fi
  sock="/run/user/$uid/fitness-hub/hub.sock"
  url="http://127.0.0.1:$LOCAL_PORT/"
  printf 'Tunnel: %s on this computer -> %s on %s\n' "$url" "$sock" "$server"
  # ControlMaster=no / ControlPath=none: a connection of its own, even if ~/.ssh/config shares
  # connections, so the options above really apply and Ctrl+C really closes the tunnel.
  ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ControlMaster=no \
    -o ControlPath=none \
    -L "127.0.0.1:$LOCAL_PORT:$sock" \
    -- "$server" &
  pid=$!
  trap 'kill "$pid" 2>/dev/null || true' INT TERM HUP
  tries=0
  while :; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rc=0
      wait "$pid" || rc=$?
      die "ssh stopped (status $rc) before the hub answered. Read its message above (troubleshooting: hosting guide, section 8)."
    fi
    if hub_answers; then
      printf 'The hub answers through the tunnel: opening %s\n' "$url"
      open_url "$url"
      break
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      printf 'The hub has not answered through the tunnel after a minute. When it does, open %s\n' "$url"
      break
    fi
    sleep 0.5
  done
  printf 'Leave this running while you use the hub; press Ctrl+C to close the tunnel.\n'
  rc=0
  wait "$pid" || rc=$?
  exit "$rc"
}

main "$@"
