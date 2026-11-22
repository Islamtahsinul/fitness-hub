#!/usr/bin/env bash
# Fitness Hub: set up (or repair) the hub as a systemd *user* service on Ubuntu.
#
#   bash ~/fitness-hub/deploy/install.sh
#
# Safe to run again at any time (it converges to the same state). It never uses sudo, never
# opens firewall ports and never changes where the hub listens: a Unix socket only you can open,
# /run/user/<uid>/fitness-hub/hub.sock, and no TCP port. You reach it from your PC through an
# SSH tunnel to that socket. It never sets up phone access either: that is the optional
# tailscale.conf drop-in (CODEX_HOSTING_GUIDE.md, section 14), which it keeps, self-checks and verifies.
#
# Steps: 1 preflight, 2 permissions, 3 self-check, 4 linger, 5 install + start, 6 verify.
set -Eeuo pipefail
umask 077  # everything this script creates is private to you

UNIT=fitness-hub.service
PORT=8642  # the tunnel's port on the PC; on this server nothing may listen on it
PY=/usr/bin/python3
UNIT_DIR="$HOME/.config/systemd/user"
BACKUP_ROOT="$HOME/fitness-hub-backups"

step() { printf '\n== %s\n' "$*"; }
ok()   { printf '[ OK ] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
die()  { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

user_bus() {
  # `systemctl --user` needs the user's runtime folder; some non-login shells don't set it.
  local rt
  rt="/run/user/$(id -u)"
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "$rt" ]; then export XDG_RUNTIME_DIR="$rt"; fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

unit_ts_env() {  # the FITNESS_HUB_TS_* settings (phone access) the installed unit and its drop-ins set, one per line
  systemctl --user show "$UNIT" --property=Environment --value 2>/dev/null | tr ' ' '\n' \
    | grep -E '^FITNESS_HUB_TS_(SOCKET|HOST|USERS)=' || true
}

show_logs() {
  printf -- '---- last service log lines ----\n' >&2
  journalctl --user -u "$UNIT" -n 25 --no-pager 2>/dev/null >&2 \
    || systemctl --user status "$UNIT" --no-pager 2>/dev/null >&2 || true
  printf -- '--------------------------------\n' >&2
}

start_service() {
  # Clear an old failure or start-limit first. Type=notify: `restart` returns once the hub
  # reports READY (or has failed).
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  systemctl --user restart "$UNIT" 2>/dev/null && systemctl --user is-active --quiet "$UNIT"
}

main() {
  local script_dir hub_dir want me uid sock listeners state code
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  hub_dir="$(cd -- "$script_dir/.." && pwd -P)"
  want="$(cd -- "$HOME" && pwd -P)/fitness-hub"
  me="$(id -un)"
  uid="$(id -u)"
  sock="/run/user/$uid/fitness-hub/hub.sock"

  step "1/6 Preflight"
  [ "$uid" -ne 0 ] || die "Run this as your normal user, not as root or with sudo (it installs a *user* service)."
  [ "$(uname -s)" = Linux ] || die "This installer is for Linux (Ubuntu)."
  [ "$hub_dir" = "$want" ] || die "The hub must be unpacked at $want (this copy is at $hub_dir). See CODEX_HOSTING_GUIDE.md, step 3."
  { [ -f "$hub_dir/server.py" ] && [ -f "$hub_dir/public/index.html" ]; } \
    || die "$hub_dir doesn't look like the Fitness Hub (server.py or public/index.html is missing)."
  [ -x "$PY" ] || die "$PY not found. Ask the user to install it:  sudo apt install python3"
  "$PY" -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || die "Python 3.10 or newer is needed; $PY is $("$PY" -V 2>&1)."
  ok "Python: $("$PY" -V 2>&1) at $PY"
  local tool
  for tool in systemctl loginctl curl ss stat find; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found. Ask the user to install it (curl: sudo apt install curl; ss: sudo apt install iproute2)."
  done
  ok "Tools found: systemctl, loginctl, curl, ss"
  [ -d "/run/user/$uid" ] || die "/run/user/$uid (your runtime folder) doesn't exist. Log in over SSH as $me (not with su or sudo), then run this again."

  step "2/6 Files and permissions"
  chmod 700 "$hub_dir"/deploy/*.sh "$hub_dir/start_hub.sh" 2>/dev/null || true
  mkdir -p -- "$hub_dir/data"
  chmod -R go-rwx -- "$hub_dir"
  if [ -d "$BACKUP_ROOT" ]; then chmod -R go-rwx -- "$BACKUP_ROOT"; fi
  ok "$hub_dir is private to $me (folders 700, files 600, scripts 700)"

  step "3/6 Self-check (server.py --check)"
  # With the unit's phone-access settings, if a tailscale.conf drop-in is already loaded (a repair run).
  local ts_env=()
  user_bus
  mapfile -t ts_env < <(unit_ts_env)
  (cd -- "$hub_dir" && env -u FITNESS_HUB_HOST -u FITNESS_HUB_DATA_DIR -u FITNESS_HUB_EXTRA_HOSTS \
      -u FITNESS_HUB_TIMEOUT_SCALE -u FITNESS_HUB_TS_SOCKET -u FITNESS_HUB_TS_HOST -u FITNESS_HUB_TS_USERS \
      FITNESS_HUB_SOCKET="$sock" FITNESS_HUB_PORT="$PORT" "${ts_env[@]}" "$PY" -I server.py --check) \
    || die "server.py --check reported a problem (see the FAIL line above)."

  step "4/6 Keep the hub running while you are logged out (linger)"
  if [ "$(loginctl show-user "$me" --property=Linger --value 2>/dev/null || true)" = yes ]; then
    ok "Linger is already on for $me"
  elif loginctl enable-linger "$me" 2>/dev/null; then
    ok "Linger enabled for $me"
  else
    die "Couldn't enable linger. Ask the user to run:  sudo loginctl enable-linger $me   then run this script again."
  fi
  user_bus
  local tries=0
  until systemctl --user show-environment >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -le 20 ] || die "Can't reach your systemd user manager (systemctl --user). Log out and back in over SSH, then run this again."
    sleep 0.5
  done
  ok "systemd user manager is reachable"

  step "5/6 Install and start the service"
  state="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
  listeners="$(ss -Hltnp "sport = :$PORT" 2>/dev/null || true)"
  if [ -n "$listeners" ] && [ "$state" != active ]; then
    die "Something is listening on TCP port $PORT on this server (a hub started by hand with ./start_hub.sh?):
$listeners
On the server the hub uses only its private socket, and verify.sh requires port $PORT to be free here.
Stop that program, then run this script again. Don't change the port."
  fi
  mkdir -p -- "$UNIT_DIR"
  install -m 600 -- "$hub_dir/deploy/$UNIT" "$UNIT_DIR/$UNIT"
  if command -v systemd-analyze >/dev/null 2>&1; then
    local notes
    notes="$(systemd-analyze --user verify "$UNIT_DIR/$UNIT" 2>&1 || true)"
    if [ -n "$notes" ]; then warn "systemd-analyze notes (usually harmless):"; printf '       %s\n' "$notes"; fi
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || systemctl --user enable "$UNIT"
  ok "Installed $UNIT_DIR/$UNIT and enabled it (starts at boot)"
  if [ -d "$UNIT_DIR/$UNIT.d" ]; then
    local others
    if [ -f "$UNIT_DIR/$UNIT.d/tailscale.conf" ]; then
      ok "Phone access over Tailscale is configured (drop-in tailscale.conf; guide, section 14): verify.sh checks it too"
    fi
    others="$(ls -1A -- "$UNIT_DIR/$UNIT.d/" | grep -vx 'tailscale.conf' || true)"
    if [ -n "$others" ]; then
      warn "Drop-ins in $UNIT_DIR/$UNIT.d/ also apply (review them: systemctl --user cat $UNIT):"
      printf '%s\n' "$others" | sed 's/^/       /'
    fi
  fi
  if start_service; then
    ok "Service started"
  else
    code="$(systemctl --user show "$UNIT" --property=ExecMainStatus --value 2>/dev/null || true)"
    show_logs
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
    die "The service didn't start (exit status ${code:-unknown}), so it was stopped and disabled. See the log above and the troubleshooting table in CODEX_HOSTING_GUIDE.md, then run this script again."
  fi

  step "6/6 Verify"
  if ! bash "$hub_dir/deploy/verify.sh"; then
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
    die "Verification failed, so the service was stopped and disabled (fail closed). Fix the [FAIL] lines (guide, section 8), then run this script again."
  fi
  printf '\ninstall: done. The hub listens on %s on this server only (no TCP port).\n' "$sock"
  printf 'Open it from your PC with the SSH tunnel: deploy/connect_from_pc.bat (or .sh) USER@HOST %s\n' "$uid"
  local ts_host
  ts_host="$(unit_ts_env | sed -n 's/^FITNESS_HUB_TS_HOST=//p' | head -n 1 || true)"
  if [ -n "$ts_host" ]; then
    printf 'Phone access (opt-in): https://%s/ through Tailscale Serve, for the allowed Tailscale logins only.\n' "$ts_host"
  fi
}

main "$@"
