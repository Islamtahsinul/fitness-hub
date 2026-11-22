#!/usr/bin/env bash
# Fitness Hub: check that the hub is running AND private. Read-only; never prints your data.
#
#   bash ~/fitness-hub/deploy/verify.sh                # every check (on the home server)
#   bash ~/fitness-hub/deploy/verify.sh --no-systemd   # tests only: just the checks on a test hub
#
# On the server the hub listens on a Unix socket, /run/user/<uid>/fitness-hub/hub.sock, and on no
# TCP port. Every HTTP check goes through that socket (curl --unix-socket), never the network.
#
# Opt-in phone access (guide, section 14): when the hub runs with FITNESS_HUB_TS_* (the drop-in
# ~/.config/systemd/user/fitness-hub.service.d/tailscale.conf), this also checks Tailscale 1.104.4+,
# that `tailscale serve status --json` maps HTTPS 443 only to the hub's ts.sock with Funnel off
# everywhere, that ts.sock is 600 and yours, and (curl --unix-socket on ts.sock) that a missing or
# wrong login, a forged Via, a wrong or missing X-Forwarded-Host and a plain-HTTP or missing
# X-Forwarded-Proto get 403 while an allowed login gets 200. Without those settings it checks that
# no Serve config points at the hub and that Funnel is off. Either way no Serve file share may be
# the hub's folder or its backups, or a folder above them.
# Fail closed: a check that can't see what it checks fails. An ss error is a FAIL, and so is a
# tailscale CLI that can't reach tailscaled while systemd says tailscaled runs (a sandbox).
# Exit status: 0 if every check passed, 1 if any check failed (see the [FAIL] lines).
#
# Testing only, and only together with --no-systemd: FITNESS_HUB_VERIFY_PORT (a TCP test hub's port,
# or the Host port of a socket test hub), FITNESS_HUB_VERIFY_SOCKET, FITNESS_HUB_DIR, FITNESS_HUB_BACKUP_ROOT,
# FITNESS_HUB_VERIFY_TS_SOCKET, FITNESS_HUB_VERIFY_TS_HOST, FITNESS_HUB_VERIFY_TS_LOGIN (a test hub's
# Tailscale settings) and FITNESS_HUB_VERIFY_TAILSCALE=1 (also run the tailscale CLI checks).
set -uo pipefail
umask 077

PORT=8642
UNIT=fitness-hub.service
BACKUP_SERVICE=fitness-hub-backup.service
BACKUP_TIMER=fitness-hub-backup.timer
HUB_DIR="$HOME/fitness-hub"
BACKUP_ROOT="$HOME/fitness-hub-backups"
SOCK="/run/user/$(id -u)/fitness-hub/hub.sock"
MODE=socket  # socket | tcp (tcp only for --no-systemd tests on a PC)
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fitness-hub"
ALLOWED_LISTENERS="$HOME/.config/fitness-hub/allowed-listeners"
TS_DROPIN="$HOME/.config/systemd/user/$UNIT.d/tailscale.conf"
TS_MIN=1.104.4     # Serve's Unix-socket fixes: root-only targets (1.98.9), paths revalidated per dial (1.104.4)
PY="$(command -v python3 || command -v python || true)"
BASE=""
DATA_BYTES=""
HEALTH_OK=0
HUB_ENV=""         # FITNESS_HUB_* settings of the running hub, one per line
TS_STATE=off       # off | on | partial: the opt-in Tailscale settings
TS_SOCK=""
TS_HOST=""
TS_LOGIN=""        # the first allowed login: used for the probes, never printed
TS_SOCK_OK=0
checks=0
fails=0

pass() { checks=$((checks + 1)); printf '[ OK ] %s\n' "$*"; }
fail() { checks=$((checks + 1)); fails=$((fails + 1)); printf '[FAIL] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }

# curl to the hub: ignore ~/.curlrc, never use a proxy, never follow redirects, give up quickly.
# In socket mode the URL only supplies the request line and Host: no TCP connection is made.
hc() {
  if [ "$MODE" = socket ]; then
    curl -q -sS --noproxy '*' --max-time 5 --unix-socket "$SOCK" "$@"
  else
    curl -q -sS --noproxy '*' --max-time 5 "$@"
  fi
}
code() { hc -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }
# The same through the Tailscale socket, as Tailscale Serve reaches it (Host: localhost).
ts_curl() { curl -q -sS --noproxy '*' --max-time 5 --unix-socket "$TS_SOCK" "$@"; }
ts_code() { ts_curl -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }

version_at_least() {  # $1 a version such as 1.104.4 or 1.104.4-t0123abc, $2 the minimum: true if $1 >= $2
  local found="${1%%[!0-9.]*}" i a b
  local -a f m
  IFS=. read -r -a f <<< "$found"
  IFS=. read -r -a m <<< "$2"
  for i in 0 1 2; do
    a="${f[i]:-0}"
    b="${m[i]:-0}"
    [[ "$a" =~ ^[0-9]{1,6}$ ]] || return 1
    if [ "$((10#$a))" -gt "$((10#$b))" ]; then return 0; fi
    if [ "$((10#$a))" -lt "$((10#$b))" ]; then return 1; fi
  done
  return 0
}

user_bus() {
  local rt
  rt="/run/user/$(id -u)"
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "$rt" ]; then export XDG_RUNTIME_DIR="$rt"; fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

SS_OUT=""
SS_ERR=""
run_ss() {  # ss ARGS...: its output in SS_OUT. Returns 1, with the reason in SS_ERR, if ss fails or complains:
  # an ss that can't read the socket tables (in a sandbox, say) must never pass for "nothing listens".
  local errf rc
  SS_OUT=""
  SS_ERR=""
  if ! errf="$(mktemp)"; then SS_ERR="mktemp failed"; return 1; fi
  SS_OUT="$(ss "$@" 2>"$errf")"
  rc=$?
  SS_ERR="$(head -c 300 -- "$errf" 2>/dev/null | tr '\n' ' ')"
  rm -f -- "$errf"
  if [ "$rc" -ne 0 ]; then SS_ERR="ss exit $rc${SS_ERR:+: $SS_ERR}"; return 1; fi
  [ -z "${SS_ERR// /}" ] || { SS_ERR="ss: $SS_ERR"; return 1; }
}

ss_failed() {  # $1 what couldn't be shown ("that ..."): the FAIL line for an ss error
  fail "Couldn't list this machine's listening sockets (${SS_ERR:-unknown error}), so it can't be shown $1. Run verify.sh outside the sandbox (guide, section 3)"
}

check_listener() {  # TCP test mode: exactly 127.0.0.1:$PORT
  local addrs bad=0 a
  if command -v ss >/dev/null 2>&1; then
    if ! run_ss -Hltn "sport = :$PORT"; then
      ss_failed "that only 127.0.0.1:$PORT listens on port $PORT"
      return
    fi
    addrs="$(printf '%s\n' "$SS_OUT" | awk 'NF {print $4}')"
  elif command -v netstat >/dev/null 2>&1; then
    if ! addrs="$(netstat -an | awk -v suffix=":$PORT" '
        toupper($0) ~ /LISTEN/ {
          for (i = 1; i <= NF; i++)
            if (length($i) > length(suffix) && substr($i, length($i) - length(suffix) + 1) == suffix) { print $i; break }
        }')"; then
      fail "netstat failed, so what listens on port $PORT can't be shown"
      return
    fi
  else
    fail "Neither ss nor netstat is available to inspect listeners (sudo apt install iproute2)"
    return
  fi
  addrs="$(printf '%s\n' "$addrs" | sed '/^$/d' | sort -u)"
  if [ -z "$addrs" ]; then
    fail "Nothing is listening on port $PORT"
    return
  fi
  while IFS= read -r a; do
    [ "$a" = "127.0.0.1:$PORT" ] || bad=1
  done <<<"$addrs"
  if [ "$bad" -eq 0 ]; then
    pass "Listening on 127.0.0.1:$PORT only"
  else
    fail "Port $PORT is listening on: $(printf '%s' "$addrs" | tr '\n' ' ')-- it must be 127.0.0.1:$PORT and nothing else"
  fi
}

check_socket() {  # socket mode: the socket 600 and its folder 700, both this user's
  local dir="${SOCK%/*}" me sock_mode dir_mode
  me="$(id -u)"
  if [ ! -S "$SOCK" ]; then
    fail "No socket at $SOCK (is the service running? systemctl --user status $UNIT)"
    return
  fi
  sock_mode="$(stat -c '%a %u' -- "$SOCK" 2>/dev/null || true)"
  dir_mode="$(stat -c '%a %u' -- "$dir" 2>/dev/null || true)"
  if [ "$sock_mode" = "600 $me" ] && [ "$dir_mode" = "700 $me" ] && [ ! -L "$dir" ]; then
    pass "Socket $SOCK is 600 in a 700 folder, both yours"
  else
    fail "The socket or its folder is not private: socket '${sock_mode:-?}', folder '${dir_mode:-?}' (expected '600 $me' and '700 $me')"
  fi
}

check_no_tcp_port() {  # socket mode: nothing at all may listen on TCP $PORT here
  local out
  if ! command -v ss >/dev/null 2>&1; then
    fail "ss is needed to check listeners (sudo apt install iproute2)"
    return
  fi
  if ! run_ss -Hltn "sport = :$PORT"; then
    ss_failed "that nothing listens on TCP port $PORT"
    return
  fi
  out="$(printf '%s\n' "$SS_OUT" | awk 'NF {print $4}' | tr '\n' ' ')"
  if [ -z "${out// /}" ]; then
    pass "Nothing listens on TCP port $PORT here (the hub uses only its socket)"
  else
    fail "Something listens on TCP port $PORT on this server ($out): the hub must use only its socket. Find it: ss -ltnp 'sport = :$PORT'"
  fi
}

check_health() {
  local body summary expect
  expect=$([ "$MODE" = socket ] && echo unix || echo tcp)
  if ! body="$(hc "$BASE/api/health" 2>/dev/null)"; then
    fail "GET /api/health did not answer"
    return
  fi
  if [ -n "$PY" ] && summary="$(printf '%s' "$body" | "$PY" -I -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("ok") is True and d.get("app") == "fitness-hub" and d.get("listen") == sys.argv[1]
size = d.get("data_bytes")
print("%s|version %s, build %s, data.json %s, last backup %s" % ("none" if size is None else size, d.get("version"),
      d.get("build"), "not created yet" if size is None else "%s bytes" % size, d.get("last_backup") or "none yet"))
' "$expect" 2>/dev/null)"; then
    DATA_BYTES="${summary%%|*}"
    HEALTH_OK=1
    pass "Health: ${summary#*|}"
  else
    fail "GET /api/health did not return this hub's health JSON (listening as '$expect')"
  fi
}

check_data_endpoint() {
  local headers status etag
  if [ "$DATA_BYTES" = none ]; then
    info "data.json doesn't exist yet, so GET /api/data was skipped (it would create it; opening the hub does)"
    return
  fi
  headers="$(hc -o /dev/null -D - "$BASE/api/data" 2>/dev/null | tr -d '\r')"
  status="$(printf '%s\n' "$headers" | awk 'NR == 1 {print $2}')"
  etag="$(printf '%s\n' "$headers" | awk -F': ' 'tolower($1) == "etag" {print $2}')"
  if [ "$status" = 200 ] && [[ "$etag" =~ ^\"[0-9a-f]{64}\"$ ]]; then
    pass "GET /api/data: 200 with a strong ETag (body not shown)"
  elif [ "$status" = 500 ]; then
    fail "GET /api/data: 500 - data/data.json is damaged; restore a backup (guide, section 9)"
  else
    fail "GET /api/data: HTTP ${status:-no answer}, ETag '${etag:-none}' (expected 200 and a sha256 ETag)"
  fi
}

check_host_allowlist() {
  local a b c d
  a="$(code -H 'Host: evil.example' "$BASE/api/health")"
  b="$(code -H 'Host: evil.example' "$BASE/")"
  c="$(code -H "Host: evil.example:$PORT" "$BASE/api/data")"
  d="$(code -H 'Host: localhost' "$BASE/api/health")"
  if [ "$a/$b/$c/$d" = 403/403/403/403 ]; then
    pass "Requests with another Host (evil.example, bare localhost) are rejected (403)"
  else
    fail "Host allowlist: expected 403/403/403/403 for foreign Host headers, got $a/$b/$c/$d"
  fi
}

check_proxy_tripwire() {  # the main socket (SSH tunnel) never trusts proxy or Tailscale identity headers
  local a b c d
  a="$(code -H 'X-Forwarded-For: 192.0.2.1' "$BASE/api/health")"
  b="$(code -H 'Via: 1.1 proxy' "$BASE/")"
  c="$(code -H 'Forwarded: for=192.0.2.1' "$BASE/api/data")"
  d="$(code -H "Tailscale-User-Login: ${TS_LOGIN:-someone@example.invalid}" -H 'X-Forwarded-Host: x.example' "$BASE/api/health")"
  if [ "$a/$b/$c/$d" = 403/403/403/403 ]; then
    pass "Requests carrying proxy headers are refused (403)"
  else
    fail "Proxy tripwire: expected 403/403/403/403 for X-Forwarded-For, Via, Forwarded and Tailscale-User-Login, got $a/$b/$c/$d"
  fi
}

check_if_match_required() {
  local c
  # A deliberately invalid body: a hub without the If-Match rule answers 400 and writes nothing.
  c="$(code -X PUT -H 'Content-Type: application/json' -H 'X-Fitness-Hub: 1' \
        --data-binary '{"verify":"no-if-match"}' "$BASE/api/data")"
  if [ "$c" = 428 ]; then
    pass "PUT /api/data without If-Match is refused (428)"
  else
    fail "PUT /api/data without If-Match returned $c (expected 428; is an old server.py running?)"
  fi
}

check_private_paths() {
  local p c body bad=""
  for p in /data/data.json /data/ /data/backups/ /../data/data.json /%2e%2e/data/data.json \
           /..%2fdata/data.json /server.py /BUILD_ID /deploy/install.sh /.hub.lock /tests/test_server.py; do
    c="$(code --path-as-is "$BASE$p")"
    case "$c" in 400|403|404) ;; *) bad="$bad $p=$c" ;; esac
  done
  body="$(hc --path-as-is "$BASE/../data/data.json" 2>/dev/null || true)"
  case "$body" in *schema_version*) bad="$bad (data.json content was returned)" ;; esac
  if [ -z "$bad" ]; then
    pass "data/, backups and server files are not web-reachable (all 4xx)"
  else
    fail "Reachable private paths:$bad"
  fi
}

check_headers() {
  local h c
  h="$(hc -o /dev/null -D - "$BASE/" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')"
  c="$(code -X OPTIONS -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: PUT' "$BASE/api/data")"
  if printf '%s\n' "$h" | grep -q "^content-security-policy: default-src 'self'" \
     && printf '%s\n' "$h" | grep -q '^x-content-type-options: nosniff' \
     && printf '%s\n' "$h" | grep -q '^x-frame-options: deny' \
     && ! printf '%s\n' "$h" | grep -q '^access-control-' && [ "$c" = 405 ]; then
    pass "Security headers present (CSP, nosniff, frame denial); no CORS (preflight 405)"
  else
    fail "Security headers missing, a CORS header present, or OPTIONS not refused (got $c)"
  fi
}

check_other_addresses() {
  local ip url c reachable="" tried=0 addrs=()
  command -v hostname >/dev/null 2>&1 || { info "No hostname command: skipped the LAN-address probe"; return; }
  read -r -a addrs <<< "$(hostname -I 2>/dev/null || true)"  # split into words, never globbed
  for ip in "${addrs[@]}"; do
    [[ "$ip" =~ ^[0-9a-fA-F.:]+$ ]] || continue
    case "$ip" in 127.*|::1) continue ;; *:*) url="http://[$ip]:$PORT/api/health" ;; *) url="http://$ip:$PORT/api/health" ;; esac
    tried=$((tried + 1))
    c="$(curl -q -s --noproxy '*' --connect-timeout 2 --max-time 4 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$c" = 000 ] || reachable="$reachable $ip(HTTP $c)"
  done
  if [ "$tried" -eq 0 ]; then
    info "No LAN addresses found to probe"
  elif [ -z "$reachable" ]; then
    pass "Port $PORT doesn't answer on this machine's other addresses ($tried probed)"
  else
    fail "Port $PORT answers on a non-loopback address:$reachable"
  fi
}

hub_env() {
  # FITNESS_HUB_* settings of the RUNNING hub (its /proc environ), else what the unit declares.
  local pid
  pid="$(systemctl --user show "$UNIT" --property=MainPID --value 2>/dev/null || true)"
  if [ -n "$pid" ] && [ "$pid" != 0 ] && [ -r "/proc/$pid/environ" ]; then
    tr '\0' '\n' < "/proc/$pid/environ" | grep '^FITNESS_HUB_' || true
  else
    systemctl --user show "$UNIT" --property=Environment --value 2>/dev/null | tr ' ' '\n' | grep '^FITNESS_HUB_' || true
  fi
}

check_systemd() {
  local state enabled linger envs others me
  me="$(id -un)"
  state="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
  if [ "$state" = active ]; then pass "Service $UNIT is active"; else fail "Service $UNIT is '${state:-unknown}' (expected active): systemctl --user status $UNIT"; fi
  enabled="$(systemctl --user is-enabled "$UNIT" 2>/dev/null || true)"
  if [ "$enabled" = enabled ]; then pass "Service is enabled (starts at boot)"; else fail "Service is '${enabled:-unknown}' at boot (expected enabled)"; fi
  linger="$(loginctl show-user "$me" --property=Linger --value 2>/dev/null || true)"
  if [ "$linger" = yes ]; then pass "Linger is on (keeps running when you log out)"; else fail "Linger is '${linger:-off}': run  loginctl enable-linger $me"; fi
  envs="$HUB_ENV"
  if printf '%s\n' "$envs" | grep -qxF "FITNESS_HUB_SOCKET=$SOCK" && printf '%s\n' "$envs" | grep -qx 'FITNESS_HUB_PORT=8642' \
     && ! printf '%s\n' "$envs" | grep -q -e '^FITNESS_HUB_HOST=' -e '^FITNESS_HUB_EXTRA_HOSTS='; then
    pass "The hub runs with FITNESS_HUB_SOCKET=$SOCK and FITNESS_HUB_PORT=8642 (no TCP host)"
  else
    fail "The hub's settings aren't FITNESS_HUB_SOCKET=$SOCK / FITNESS_HUB_PORT=8642 without FITNESS_HUB_HOST (found: $(printf '%s' "$envs" | grep -v '^FITNESS_HUB_TS_USERS=' | tr '\n' ' '))"
  fi
  others="$(printf '%s\n' "$envs" | grep -v -e '^FITNESS_HUB_SOCKET=' -e '^FITNESS_HUB_PORT=' -e '^FITNESS_HUB_TS_' -e '^$' || true)"
  if [ -n "$others" ]; then warn "Other hub settings in effect (normally only for tests): $(printf '%s' "$others" | tr '\n' ' ')"; fi
}

env_value() {  # $1 a FITNESS_HUB_* name: its value among the running hub's settings, or nothing
  printf '%s\n' "$HUB_ENV" | sed -n "s/^$1=//p" | head -n 1
}

load_ts_settings() {  # $1 systemd | test: the opt-in Tailscale settings and TS_STATE
  local users
  if [ "$1" = systemd ]; then
    TS_SOCK="$(env_value FITNESS_HUB_TS_SOCKET)"
    TS_HOST="$(env_value FITNESS_HUB_TS_HOST)"
    users="$(env_value FITNESS_HUB_TS_USERS)"
  else
    TS_SOCK="${FITNESS_HUB_VERIFY_TS_SOCKET:-}"
    TS_HOST="${FITNESS_HUB_VERIFY_TS_HOST:-}"
    users="${FITNESS_HUB_VERIFY_TS_LOGIN:-}"
  fi
  TS_HOST="$(printf '%s' "$TS_HOST" | tr 'A-Z' 'a-z')"
  TS_LOGIN="${users%%,*}"
  TS_LOGIN="${TS_LOGIN//[[:space:]]/}"
  if [ -n "$TS_SOCK" ] && [ -n "$TS_HOST" ] && [ -n "$TS_LOGIN" ]; then
    TS_STATE=on
  elif [ -n "$TS_SOCK$TS_HOST$users" ] || { [ "$1" = systemd ] && [ -f "$TS_DROPIN" ]; }; then
    TS_STATE=partial
  else
    TS_STATE=off
  fi
}

check_ts_config() {  # systemd: the Tailscale drop-in and the running hub agree
  case "$TS_STATE" in
    on)
      if [ -f "$TS_DROPIN" ]; then
        info "Phone access over Tailscale is on: https://$TS_HOST/ through $TS_SOCK (drop-in $TS_DROPIN)"
      else
        warn "Phone access over Tailscale is on, but not through $TS_DROPIN: review  systemctl --user cat $UNIT  (guide, section 14)"
      fi
      ;;
    partial)
      if [ -z "$TS_SOCK$TS_HOST$TS_LOGIN" ]; then
        fail "The Tailscale drop-in $TS_DROPIN exists, but the running hub doesn't use it: systemctl --user daemon-reload && systemctl --user restart $UNIT  (or remove the drop-in: guide, section 14)"
      else
        fail "The hub's Tailscale settings are incomplete: FITNESS_HUB_TS_SOCKET, FITNESS_HUB_TS_HOST and FITNESS_HUB_TS_USERS must all be set (systemctl --user cat $UNIT)"
      fi
      ;;
  esac
}

check_ts_socket() {  # the Tailscale socket: 600 and yours, in the hub's own 700 folder (checked above)
  local me mode
  me="$(id -u)"
  if [ ! -S "$TS_SOCK" ]; then
    fail "No Tailscale socket at $TS_SOCK (is the hub running with its Tailscale settings? systemctl --user status $UNIT)"
    return
  fi
  mode="$(stat -c '%a %u' -- "$TS_SOCK" 2>/dev/null || true)"
  if [ "$mode" = "600 $me" ] && [ "${TS_SOCK%/*}" = "${SOCK%/*}" ]; then
    TS_SOCK_OK=1
    pass "Tailscale socket $TS_SOCK is 600 and yours, in the hub's 700 folder"
  else
    fail "The Tailscale socket isn't private: '${mode:-?}' in ${TS_SOCK%/*} (expected '600 $me' in ${SOCK%/*})"
  fi
}

check_ts_listener() {  # through ts.sock as Serve reaches it: identity first, then the write checks
  local base=http://localhost a b c d e f g body summary w1 w2
  local -a fwd who
  fwd=(-H "X-Forwarded-Host: $TS_HOST" -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 100.64.0.1')
  who=(-H "Tailscale-User-Login: $TS_LOGIN")
  a="$(ts_code "${fwd[@]}" "$base/api/health")"                                                    # no login
  b="$(ts_code "${fwd[@]}" -H 'Tailscale-User-Login: verify-not-allowed@fitness-hub.invalid' "$base/api/health")"
  c="$(ts_code "${fwd[@]}" "${who[@]}" -H 'Via: 1.1 forged-proxy' "$base/api/health")"
  d="$(ts_code -H 'X-Forwarded-Host: evil.example' -H 'X-Forwarded-Proto: https' "${who[@]}" "$base/api/health")"
  e="$(ts_code -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 100.64.0.1' "${who[@]}" "$base/api/health")"  # no X-Forwarded-Host
  f="$(ts_code -H "X-Forwarded-Host: $TS_HOST" -H 'X-Forwarded-Proto: http' "${who[@]}" "$base/api/health")"     # plain HTTP
  g="$(ts_code -H "X-Forwarded-Host: $TS_HOST" -H 'X-Forwarded-For: 100.64.0.1' "${who[@]}" "$base/api/health")" # no X-Forwarded-Proto
  body="$(ts_curl "${fwd[@]}" "${who[@]}" "$base/api/health" 2>/dev/null || true)"
  summary=""
  if [ -n "$PY" ]; then
    summary="$(printf '%s' "$body" | "$PY" -I -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("ok") is True and d.get("app") == "fitness-hub" and d.get("listen") == "tailscale"
print(200)' 2>/dev/null || true)"
  fi
  if [ "$a/$b/$c/$d/$e/$f/$g/$summary" = 403/403/403/403/403/403/403/200 ]; then
    pass "Tailscale socket: no login, a wrong login, a forged Via, a wrong or missing X-Forwarded-Host and a plain-HTTP or missing X-Forwarded-Proto get 403; an allowed login gets 200"
  else
    fail "Tailscale socket: expected 403 x7 (no login, wrong login, Via, wrong host, no host, http, no proto) and a 200 health answer for the allowed login, got $a/$b/$c/$d/$e/$f/$g/${summary:-no health JSON}"
  fi
  # Deliberately invalid bodies: both are refused before the body is read, so nothing is written.
  w1="$(ts_code -X PUT "${fwd[@]}" "${who[@]}" -H 'Content-Type: application/json' -H 'X-Fitness-Hub: 1' \
        --data-binary '{"verify":"no-origin"}' "$base/api/data")"
  w2="$(ts_code -X PUT "${fwd[@]}" "${who[@]}" -H 'Content-Type: application/json' -H 'X-Fitness-Hub: 1' \
        -H "Origin: https://$TS_HOST" --data-binary '{"verify":"no-if-match"}' "$base/api/data")"
  if [ "$w1/$w2" = 403/428 ]; then
    pass "Tailscale socket: saves need Origin https://$TS_HOST (403 without it), then If-Match (428)"
  else
    fail "Tailscale socket: a PUT without Origin should get 403 and one without If-Match 428, got $w1/$w2"
  fi
}

check_user_listeners() {  # programs of this user listening on a non-loopback address could relay the hub
  local line addr prog port bad="" known=""
  if ! command -v ss >/dev/null 2>&1; then
    fail "ss is needed to check listeners (sudo apt install iproute2)"
    return
  fi
  if ! run_ss -Hltnp; then
    ss_failed "that none of your programs listens on the network"
    return
  fi
  while IFS= read -r line; do
    case "$line" in *'users:(('*) ;; *) continue ;; esac  # ss shows users:(...) only for your own processes
    addr="$(printf '%s\n' "$line" | awk '{print $4}')"
    case "$addr" in 127.*|'[::1]':*|::1:*|'[::ffff:127.'*) continue ;; esac
    prog="$(printf '%s\n' "$line" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')"
    port="${addr##*:}"
    if [ -f "$ALLOWED_LISTENERS" ] && grep -qxF -- "${prog:-?}:$port" "$ALLOWED_LISTENERS"; then
      known="$known ${prog:-?}:$port"
      continue
    fi
    bad="$bad ${prog:-?} on $addr;"
  done <<< "$SS_OUT"
  if [ -n "$known" ]; then info "Network listeners the user accepted ($ALLOWED_LISTENERS):$known"; fi
  if [ -z "$bad" ]; then
    pass "None of your programs listens on a network address (loopback only)"
  else
    fail "Your programs listen on the network:$bad they could expose the hub or its files. STOP AND ASK (guide, section 8)"
  fi
}

check_proxy_configs() {  # no web server or proxy may be configured to pass requests to the hub
  local d dirs=() hits
  for d in /etc/nginx /etc/apache2 /etc/httpd /etc/caddy /etc/haproxy /etc/traefik /usr/local/etc/nginx \
           "$HOME/.config/caddy" "$HOME/Caddyfile"; do
    [ -e "$d" ] && dirs+=("$d")
  done
  if [ "${#dirs[@]}" -eq 0 ]; then
    pass "No web server or proxy configuration here (nginx, Apache, Caddy, HAProxy, Traefik)"
    return
  fi
  hits="$(grep -rIlsE -- '(^|[^0-9])8642([^0-9]|$)|fitness-hub|hub\.sock' "${dirs[@]}" 2>/dev/null | head -n 5 | tr '\n' ' ' || true)"
  if [ -z "$hits" ]; then
    pass "No web server or proxy configuration mentions the hub"
  else
    fail "Web server or proxy files mention the hub: $hits-- STOP AND ASK (guide, section 8)"
  fi
}

# Arguments of the analyzer: mode (off | ts), the Tailscale name, ts.sock, then the hub's folders (its
# socket folder, HUB_DIR, BACKUP_ROOT): no Serve value may name them, and no Serve Path share may be
# one of them or a folder above them.
ts_serve_analyzer() {  # Python: reads `tailscale serve status --json`, prints OK|..., FAIL|... and WARN|... lines
  cat <<'PYEOF'
import json, os, posixpath, re, sys
mode, host, sock = sys.argv[1:4]
markers = [m for m in sys.argv[4:] if m]
folders = [m for m in markers if m.startswith("/")]
raw = sys.stdin.read()

def say(kind, text):
    print(kind + "|" + text.replace("\n", " "))

try:
    cfg = json.loads(raw) if raw.strip() else {}
except ValueError:
    cfg = "bad"
if cfg is None:
    cfg = {}
if not isinstance(cfg, dict):
    say("FAIL", "'tailscale serve status --json' didn't print a JSON object. STOP AND ASK the user to run  tailscale serve status")
    sys.exit(0)

HUB = re.compile(r"fitness-hub|(?<![0-9])8642(?![0-9])")
expected = "unix:" + sock
expected_at = ("Web", host + ":443", "Handlers", "/", "Proxy")
funnel, hub_refs, over = [], [], []

def forms(path):  # a path as written (normalised) and, on this machine, with its symlinks resolved
    found = {posixpath.normpath("/" + path.lstrip("/"))}
    if os.name == "posix":
        found.add(os.path.realpath(path))
    return found

def covers(share, folder):  # does sharing `share` hand out `folder`? (the same folder, or one above it)
    return any(s == f or f.startswith(s.rstrip("/") + "/") for s in forms(share) for f in forms(folder))

def walk(node, path):
    if isinstance(node, dict):
        for key, value in node.items():
            key = str(key)
            if key == "AllowFunnel":
                if isinstance(value, dict):
                    funnel.extend(str(k) for k, on in value.items() if on)
                elif value:
                    funnel.append("/".join(path) or "everything")
            walk(value, path + (key,))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            walk(value, path + (str(i),))
    elif isinstance(node, str):
        if path and path[-1] == "Path" and (not node.startswith("/") or any(covers(node, f) for f in folders)):
            over.append((path, node))  # a file share of the hub's folders, or of a folder above them
        elif HUB.search(node) or any(m in node for m in markers):
            if not (mode == "ts" and path == expected_at and node == expected):
                hub_refs.append(path)

walk(cfg, ())
refs = hub_refs + [p for p, _ in over]  # everything that leads to the hub: not "other shares" below
hub_ports = {p[1] for p in refs if len(p) > 1 and p[0] == "TCP"}
hub_ports |= {p[1].rsplit(":", 1)[-1] for p in refs if len(p) > 1 and p[0] == "Web"}
hub_keys = {name: {p[1] for p in refs if len(p) > 1 and p[0] == name} for name in ("Foreground", "Services")}
shown = ", ".join("/".join(p) for p in hub_refs[:3])

def only(d, keys):
    return isinstance(d, dict) and not any(v for k, v in d.items() if k not in keys)

def table(name):
    value = cfg.get(name)
    return value if isinstance(value, dict) else {}

tcp, web = table("TCP"), table("Web")
problems = 0
if funnel:
    problems += 1
    say("FAIL", "Tailscale Funnel is ON (" + ", ".join(sorted(set(funnel))[:3]) + "): that publishes to the "
        "internet, which the hub never is. STOP AND ASK; with the user's OK turn it off (guide, section 14)")
if mode == "ts":
    port = tcp.get("443")
    site = web.get(host + ":443")
    handlers = site.get("Handlers") if isinstance(site, dict) else None
    handler = handlers.get("/") if isinstance(handlers, dict) else None
    exact = (isinstance(port, dict) and port.get("HTTPS") is True and only(port, {"HTTPS"})
             and only(site, {"Handlers"}) and isinstance(handlers, dict) and list(handlers) == ["/"]
             and isinstance(handler, dict) and handler.get("Proxy") == expected and only(handler, {"Proxy"}))
    also = sorted(str(k) for k in web if str(k) != host + ":443" and str(k).rsplit(":", 1)[-1] == "443")
    if not exact or also:
        problems += 1
        say("FAIL", "Tailscale Serve doesn't map https://%s/ (HTTPS 443) to exactly one handler, / -> %s%s. With the "
            "user's OK: sudo tailscale serve --https=443 off, then sudo tailscale serve --bg --https=443 %s (guide, "
            "section 14)" % (host, expected, " (443 also serves " + ", ".join(also) + ")" if also else "", expected))
if over:
    problems += 1
    say("FAIL", "Tailscale Serve shares files from a folder that is, or holds, the hub's code, data or backups "
        "(%s). That would hand out the user's health data. STOP AND ASK; with the user's OK remove that share: "
        "sudo tailscale serve --https=PORT off for its port (guide, section 14)"
        % ", ".join("%s at %s" % (value, "/".join(p)) for p, value in over[:3]))
if hub_refs:
    problems += 1
    if mode == "ts":
        say("FAIL", "Tailscale Serve also points at the hub elsewhere (%s): only https://%s/ -> %s is allowed. "
            "STOP AND ASK" % (shown, host, expected))
    else:
        say("FAIL", "Tailscale Serve points at the hub (%s), but phone access isn't configured here (no Tailscale "
            "settings). STOP AND ASK; with the user's OK remove it (guide, section 14)" % shown)
if not problems:
    if mode == "ts":
        say("OK", "Tailscale Serve maps https://%s/ (HTTPS 443) only to the hub's Tailscale socket, and Funnel is off" % host)
    else:
        say("OK", "Tailscale Serve doesn't point at the hub, and Funnel is off")
extra = []
ports = sorted(str(p) for p in tcp if str(p) not in hub_ports and not (mode == "ts" and str(p) == "443"))
if ports:
    extra.append("port " + ", ".join(ports[:5]))
for name, label in (("Foreground", "foreground session"), ("Services", "Tailscale Service")):
    count = len([k for k in table(name) if str(k) not in hub_keys[name]])
    if count:
        extra.append("%d %s(s)" % (count, label))
if extra:
    say("WARN", "Tailscale Serve also shares other things on this server (" + "; ".join(extra) + "), not the hub. "
        "Report them to the user.")
PYEOF
}

check_tailscale_version() {  # phone access needs Tailscale (client and running daemon) 1.104.4 or newer
  local cli daemon
  cli="$(tailscale version 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
  daemon=""
  if [ -n "$PY" ]; then
    daemon="$(tailscale status --json 2>/dev/null | "$PY" -I -c '
import json, sys
try:
    v = json.load(sys.stdin).get("Version")
except Exception:
    v = None
print(v if isinstance(v, str) else "")' 2>/dev/null || true)"
  fi
  if [ -z "$cli" ]; then
    fail "Couldn't read the Tailscale version (tailscale version); phone access needs $TS_MIN or newer"
  elif ! version_at_least "$cli" "$TS_MIN"; then
    fail "Tailscale $cli is too old for phone access: $TS_MIN or newer is needed (Serve's Unix-socket fixes). STOP AND ASK the user to upgrade it (sudo apt install tailscale)"
  elif [ -n "$daemon" ] && ! version_at_least "$daemon" "$TS_MIN"; then
    fail "The running tailscaled is ${daemon%%-*}, older than $TS_MIN (the client is $cli). STOP AND ASK the user to restart it (sudo systemctl restart tailscaled)"
  else
    pass "Tailscale $cli${daemon:+ (daemon ${daemon%%-*})} is $TS_MIN or newer"
  fi
}

tailscaled_state() {  # what systemd says tailscaled is (active, inactive, failed, ...), or nothing if it can't tell
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl is-active tailscaled 2>/dev/null | head -n 1 | tr -d '[:space:]'
}

check_tailscale() {  # Funnel always off; Serve may point at the hub only as the opt-in phone access maps it
  local out err errf rc result kind text daemon mode=off
  if [ "$TS_STATE" = on ]; then mode=ts; fi
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ "$TS_STATE" = off ]; then
      info "Tailscale not installed: nothing to check"
    else
      fail "Phone access over Tailscale is configured, but the tailscale command isn't installed here"
    fi
    return
  fi
  if [ "$mode" = ts ]; then check_tailscale_version; fi
  if ! errf="$(mktemp)"; then fail "mktemp failed: couldn't check Tailscale"; return; fi
  out="$(tailscale serve status --json 2>"$errf")"
  rc=$?
  err="$(head -c 400 -- "$errf" 2>/dev/null | tr '\n' ' ')"
  rm -f -- "$errf"
  if [ "$rc" -ne 0 ]; then
    if printf '%s %s' "$err" "$out" | grep -qiE 'failed to connect|connection refused|not running'; then
      # The CLI couldn't reach tailscaled. That proves Tailscale shares nothing only if systemd says
      # tailscaled isn't running: from inside a sandbox the CLI can't reach a daemon that runs fine.
      daemon="$(tailscaled_state)"
      case "$daemon" in
        inactive | failed)
          if [ "$mode" = off ]; then
            pass "Tailscale isn't running here, so it shares nothing"
          else
            fail "Tailscale isn't running here (tailscaled is $daemon): phone access is down and its Serve settings can't be checked. STOP AND ASK"
          fi ;;
        *)
          fail "The tailscale command can't reach tailscaled (${err:-exit $rc}), and systemd says tailscaled is '${daemon:-unknown}', so its Serve and Funnel settings can't be checked. Run verify.sh outside the sandbox (guide, section 3)" ;;
      esac
    elif printf '%s %s' "$err" "$out" | grep -qiE 'is stopped|NeedsLogin|logged out'; then
      if [ "$mode" = off ]; then
        pass "Tailscale is stopped or logged out here, so it shares nothing"
      else
        fail "Tailscale is stopped or logged out here (${err:-no answer}): phone access is down and its Serve settings can't be checked. STOP AND ASK"
      fi
    else
      fail "Couldn't read 'tailscale serve status --json' (${err:-exit $rc}). STOP AND ASK the user to run  tailscale serve status  and report what it shows"
    fi
    return
  fi
  if [ -z "$PY" ]; then fail "python3 is needed to read the Tailscale settings"; return; fi
  result="$(printf '%s' "$out" | "$PY" -I -c "$(ts_serve_analyzer)" "$mode" "$TS_HOST" "$TS_SOCK" "${SOCK%/*}" "$HUB_DIR" "$BACKUP_ROOT" 2>/dev/null || true)"
  if ! printf '%s\n' "$result" | grep -qE '^(OK|FAIL)\|'; then
    fail "Couldn't analyse 'tailscale serve status --json'. STOP AND ASK the user to run  tailscale serve status"
    return
  fi
  while IFS='|' read -r kind text; do
    case "$kind" in
      OK) pass "$text" ;;
      FAIL) fail "$text" ;;
      WARN) warn "$text" ;;
    esac
  done <<< "$result"
}

check_backups() {  # SRE6: when off-machine backups are set up, their last run must have succeeded
  local timer_file="$HOME/.config/systemd/user/$BACKUP_TIMER" enabled active result status
  if [ -f "$timer_file" ]; then
    enabled="$(systemctl --user is-enabled "$BACKUP_TIMER" 2>/dev/null || true)"
    active="$(systemctl --user is-active "$BACKUP_TIMER" 2>/dev/null || true)"
    result="$(systemctl --user show "$BACKUP_SERVICE" --property=Result --value 2>/dev/null || true)"
    if [ "$enabled/$active/$result" = enabled/active/success ]; then
      pass "Backup timer is on and its last run succeeded"
    else
      fail "Backup timer: ${enabled:-?}/${active:-?}, last result '${result:-unknown}' (expected enabled/active/success): journalctl --user -u $BACKUP_SERVICE -n 20"
    fi
  fi
  if [ -f "$STATE_DIR/backup-status" ]; then
    status="$(head -n 1 -- "$STATE_DIR/backup-status" 2>/dev/null || true)"
    case "$status" in
      "ok "*) pass "Last backup run: $status" ;;
      *) fail "The last backup run failed: ${status:-unreadable} (log: $STATE_DIR/backup.log, or journalctl --user -u $BACKUP_SERVICE)" ;;
    esac
  fi
  if [ ! -f "$timer_file" ] && [ ! -f "$STATE_DIR/backup-status" ]; then
    info "No off-machine backups set up (backup.sh): nothing to check"
  fi
}

check_permissions() {
  local path f bad=""
  if [ "$(uname -s)" != Linux ]; then info "Not Linux: file-permission checks skipped"; return; fi
  if [ ! -d "$HUB_DIR/data" ]; then fail "No data folder at $HUB_DIR/data"; return; fi
  for path in "$HUB_DIR" "$BACKUP_ROOT"; do
    [ -e "$path" ] || continue
    while IFS= read -r f; do
      bad="$bad ${f#"$HOME"/}"
    done < <(find "$path" ! -type l -perm /077 2>/dev/null | head -n 5)
  done
  if [ -z "$bad" ]; then
    pass "The hub folder (code and data) and its backups are private (no access for group or others)"
  else
    fail "Readable by other users:$bad -- fix: chmod -R go-rwx $HUB_DIR $BACKUP_ROOT (install.sh does this)"
  fi
}

main() {
  local systemd=1
  case "${1:-}" in
    --no-systemd) systemd=0 ;;
    "") ;;
    *) printf 'usage: %s [--no-systemd]\n' "$0" >&2; exit 2 ;;
  esac
  if [ "$systemd" -eq 0 ]; then
    PORT="${FITNESS_HUB_VERIFY_PORT:-8642}"
    if [ -n "${FITNESS_HUB_VERIFY_SOCKET:-}" ]; then SOCK="$FITNESS_HUB_VERIFY_SOCKET"; else MODE=tcp; fi
    HUB_DIR="${FITNESS_HUB_DIR:-$HUB_DIR}"
    BACKUP_ROOT="${FITNESS_HUB_BACKUP_ROOT:-$BACKUP_ROOT}"
  elif [ -n "${FITNESS_HUB_VERIFY_PORT:-}${FITNESS_HUB_VERIFY_SOCKET:-}${FITNESS_HUB_DIR:-}${FITNESS_HUB_BACKUP_ROOT:-}${FITNESS_HUB_VERIFY_TS_SOCKET:-}${FITNESS_HUB_VERIFY_TS_HOST:-}${FITNESS_HUB_VERIFY_TS_LOGIN:-}${FITNESS_HUB_VERIFY_TAILSCALE:-}" ]; then
    warn "Ignoring FITNESS_HUB_VERIFY_* / FITNESS_HUB_DIR / FITNESS_HUB_BACKUP_ROOT: they only apply with --no-systemd (testing)"
  fi
  BASE="http://127.0.0.1:$PORT"
  command -v curl >/dev/null 2>&1 || { printf '[FAIL] curl is needed: sudo apt install curl\n'; exit 1; }
  if [ "$MODE" = socket ]; then printf 'Fitness Hub verification (socket %s)\n' "$SOCK"; else printf 'Fitness Hub verification (port %s)\n' "$PORT"; fi
  if [ "$systemd" -eq 1 ]; then
    user_bus
    if command -v systemctl >/dev/null 2>&1; then
      HUB_ENV="$(hub_env)"
      load_ts_settings systemd
      check_systemd
      check_ts_config
    else
      load_ts_settings systemd
      fail "systemctl not found (use --no-systemd outside systemd)"
    fi
  else
    load_ts_settings test
  fi
  if [ "$MODE" = socket ]; then
    check_socket
    check_no_tcp_port
  else
    check_listener
  fi
  if [ "$TS_STATE" = on ]; then check_ts_socket; fi
  check_health
  if [ "$HEALTH_OK" -eq 1 ]; then
    check_data_endpoint
    check_host_allowlist
    check_proxy_tripwire
    check_if_match_required
    check_private_paths
    check_headers
    if [ "$TS_STATE" = on ] && [ "$TS_SOCK_OK" -eq 1 ]; then
      check_ts_listener
    elif [ "$TS_STATE" = on ]; then
      info "The Tailscale socket checks were skipped: the socket isn't there or isn't private (see above)"
    fi
  else
    info "The other HTTP checks were skipped: the hub didn't answer /api/health properly (and /api/data is never fetched then)"
  fi
  check_other_addresses
  if [ "$systemd" -eq 1 ]; then
    check_user_listeners
    check_proxy_configs
    check_tailscale
    check_backups
  elif [ "${FITNESS_HUB_VERIFY_TAILSCALE:-}" = 1 ]; then
    check_tailscale  # tests only: with a stand-in tailscale command first on PATH
  fi
  check_permissions
  printf '\n'
  if [ "$fails" -eq 0 ]; then
    printf 'verify: ALL %d CHECKS PASSED\n' "$checks"
    exit 0
  fi
  printf 'verify: %d OF %d CHECKS FAILED\n' "$fails" "$checks"
  exit 1
}

# Run when executed (bash verify.sh ..., or fed on stdin). The tests source this file to call single
# checks with stand-ins, and then main doesn't run.
if ! (return 0 2>/dev/null); then main "$@"; fi
